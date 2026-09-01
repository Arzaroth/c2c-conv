import { createServer as createUnixServer } from 'node:net'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'
import { TranscriptStream } from './transcript.js'
import { Policy, GALLERY, RING } from './policy.js'
import { LocalTransport } from './transport/local.js'
import { BigtopTransport } from './transport/bigtop.js'
import { controlSocket, ensureStateDir, metaFile, paneFile, statusFile } from './paths.js'

const MAX_PANE_BYTES = Number(process.env.C2C_MAX_PANE_BYTES) || 8 * 1024 * 1024
const MAX_HISTORY = 500

export class Ringmaster {
  #session
  #token
  #policy = new Policy()
  #guests = new Map()
  #transports = []
  #pane = null
  #control = null
  #bigtopStatus = null
  #paneState = 'unknown'
  #paneSize = { cols: 0, rows: 0 }
  #stateTimer = null
  #writes = Promise.resolve()
  #transcript = null
  #history = []

  constructor({ session, port, host = '127.0.0.1', token, bigtop }) {
    this.#session = session
    this.#token = token || randomBytes(16).toString('hex')

    this.#transports.push(new LocalTransport({ port, host, token: this.#token }))

    if (bigtop?.url) {
      this.#transports.push(
        new BigtopTransport({ url: bigtop.url, room: bigtop.room, token: bigtop.token || this.#token })
      )
    }
  }

  get token() {
    return this.#token
  }

  get local() {
    return this.#transports.find((t) => t.name === 'local')
  }

  get bigtop() {
    return this.#transports.find((t) => t.name === 'bigtop')
  }

  get url() {
    return this.local.url
  }

  get policy() {
    return this.#policy
  }

  async start() {
    await ensureStateDir(this.#session)
    await writeFile(paneFile(this.#session), '')
    await tmux.startPipe(this.#session, paneFile(this.#session))

    this.#pane = new PaneStream(paneFile(this.#session))
    this.#pane.on('data', (chunk) => {
      for (const transport of this.#transports) transport.broadcastBinary(chunk)
    })
    await this.#pane.start()

    this.#policy.onEvent((event) => this.#onPolicyEvent(event))

    for (const transport of this.#transports) {
      transport.on('guest', (channel) => this.#onGuest(channel))
      transport.on('status', (status) => {
        this.#bigtopStatus = status
        console.log(`[bigtop] ${JSON.stringify(status)}`)
      })
      await transport.start()
    }

    this.#transcript = new TranscriptStream(this.#session)
    this.#transcript.on('entry', (entry) => {
      this.#history.push(entry)
      if (this.#history.length > MAX_HISTORY) this.#history.shift()
      this.#broadcastJson({ type: 'transcript', entry })
    })
    this.#transcript.on('located', (info) => console.log(`[transcript] ${info.path}`))
    this.#transcript.start()

    this.#watchPaneState()
    await this.#writeStatusLine()

    await this.#startControl()
    await writeFile(metaFile(this.#session), JSON.stringify(this.#meta(), null, 2))
  }

  announce(text) {
    this.#broadcastJson({ type: 'notice', text })
  }

  // Distinct from a notice so guests know not to keep reconnecting.
  announceEnd(text) {
    this.#broadcastJson({ type: 'bye', text })
  }

  async stop() {
    clearInterval(this.#stateTimer)
    await this.#transcript?.stop()
    await tmux.stopPipe(this.#session)
    await this.#pane?.stop()
    for (const transport of this.#transports) await transport.stop()
    this.#control?.close()
    // pane.raw is a transient buffer, not a record. ringmaster.log stays.
    for (const path of [controlSocket(this.#session), metaFile(this.#session), paneFile(this.#session)]) {
      try {
        await unlink(path)
      } catch {}
    }
  }

  #watchPaneState() {
    this.#stateTimer = setInterval(async () => {
      try {
        const state = await tmux.paneState(this.#session)
        if (state !== this.#paneState) {
          this.#paneState = state
          this.#broadcastJson({ type: 'state', state })
        }

        // tmux resizes the pane to whatever client attaches, so the geometry
        // changes under guests who would otherwise keep rendering the old grid.
        const size = await tmux.paneSize(this.#session)
        if (size.cols !== this.#paneSize.cols || size.rows !== this.#paneSize.rows) {
          this.#paneSize = size
          this.#broadcastJson({ type: 'resize', ...size })
          await this.#reseed()
        }

        await this.#rotatePaneFile()
      } catch {}
    }, 1000)
  }

  async #screenMessage() {
    return {
      type: 'screen',
      data: await tmux.capturePane(this.#session),
      cursor: await tmux.cursor(this.#session),
    }
  }

  async #reseed() {
    this.#broadcastJson(await this.#screenMessage())
  }

  async #sendScreen(channel) {
    if (!channel.closed) channel.sendJson(await this.#screenMessage())
  }

  // pipe-pane appends for the lifetime of the session. Rotating loses the bytes
  // written between stop and start, so guests get a fresh snapshot afterwards
  // rather than a stream with a hole in it.
  async #rotatePaneFile() {
    const file = paneFile(this.#session)
    const { size } = await stat(file)
    if (size < MAX_PANE_BYTES) return

    await tmux.stopPipe(this.#session)
    await writeFile(file, '')
    this.#pane.rewind()
    await tmux.startPipe(this.#session, file)
    await this.#reseed()
  }

  #meta() {
    const local = this.local
    return {
      session: this.#session,
      pid: process.pid,
      port: local.port,
      token: this.#token,
      url: local.url,
      bigtop: this.bigtop ? { url: this.bigtop.guestUrl } : null,
    }
  }

  async #onGuest(channel) {
    const guest = { id: channel.id, name: 'guest', origin: channel.origin, channel }
    this.#guests.set(channel.id, guest)

    channel.on('text', (raw) => this.#onGuestMessage(guest, raw))
    channel.on('close', () => {
      this.#guests.delete(channel.id)
      this.#writeStatusLine()
      this.#notifyHost(`c2c: ${guest.name} left (${this.#guests.size} connected)`)
    })

    const { cols, rows } = await tmux.paneSize(this.#session)
    channel.sendJson({
      type: 'hello',
      mode: this.#policy.mode,
      state: this.#paneState,
      cols,
      rows,
      guestId: guest.id,
    })
    await this.#sendScreen(channel)
    if (this.#history.length) {
      channel.sendJson({ type: 'transcript:history', entries: this.#history })
    }
    this.#writeStatusLine()
    this.#notifyHost(`c2c: a guest connected via ${channel.origin} (${this.#guests.size} connected)`)
  }

  #onGuestMessage(guest, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'name' && typeof msg.name === 'string') {
      guest.name = msg.name.slice(0, 40).replace(/[^\w .-]/g, '') || 'guest'
      guest.channel.sendJson({ type: 'named', name: guest.name })
      return
    }

    // A browser guest renders the live byte stream, so it only needs a snapshot
    // when it joins. A programmatic guest has no terminal emulator and has to
    // be able to ask for the current screen.
    if (msg.type === 'refresh') {
      this.#sendScreen(guest.channel)
      return
    }

    if (msg.type === 'key') {
      const result = this.#policy.submitKey({ key: msg.key, guest: guest.name })
      if (result.action === 'send') this.#pressKey(result.key)
      else guest.channel.sendJson({ type: 'key:refused', key: msg.key, reason: result.reason })
      return
    }

    if (msg.type === 'submit') {
      const result = this.#policy.submit({ text: msg.text, guest: guest.name })
      if (result.action === 'send') {
        this.#inject(result.text)
        guest.channel.sendJson({ type: 'accepted', text: result.text })
      } else if (result.action === 'queued') {
        guest.channel.sendJson({ type: 'pending', id: result.id, text: msg.text })
      } else if (result.action === 'rejected') {
        guest.channel.sendJson({ type: 'rejected', reason: result.reason })
      }
    }
  }

  // Keys deliberately skip the prompt guard: answering a dialog is the whole
  // reason they exist. Digits go in as literal text so numbered menus work.
  async #pressKey(key) {
    if (/^[1-9]$/.test(key)) await tmux.sendText(this.#session, key)
    else await tmux.sendKey(this.#session, key)
  }

  // Two writers on one pty interleave, so every text injection is serialised
  // behind the last one. Keys deliberately skip this queue: they are single
  // atomic keystrokes and should not wait out a text injection's timeout.
  #inject(text) {
    this.#writes = this.#writes
      .then(() => this.#injectNow(text))
      .catch((err) => {
        // A guest message disappearing without a trace is the worst possible
        // failure here, so a broken write is loud on both sides.
        console.error(`[inject] failed: ${err?.message ?? err}`)
        this.#notifyHost(`c2c: FAILED to deliver a guest message - ${err?.message ?? err}`)
        this.#broadcastJson({ type: 'policy:held', state: 'error', text })
        return false
      })
    return this.#writes
  }

  async #injectNow(text) {
    console.log(`[inject] start: ${JSON.stringify(text.slice(0, 40))}`)
    const state = await tmux.waitForPrompt(this.#session)
    if (state !== 'prompt') return this.#hold(state, text)

    // The host typing is the other writer the queue cannot see.
    const draft = await tmux.promptDraft(this.#session)
    if (draft) return this.#hold('draft', text)

    await tmux.submit(this.#session, text)
    await this.#settle()
    console.log('[inject] delivered')
    return true
  }

  // send-keys returns once tmux has queued the keys, well before the session
  // renders them, so a single "is the box empty" check passes while the text is
  // still in flight and the next queued message then catches it mid-render and
  // is held as a phantom draft. Wait for the box to read empty twice running.
  async #settle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    await new Promise((r) => setTimeout(r, 250))

    let consecutiveEmpty = 0
    while (Date.now() < deadline) {
      const draft = await tmux.promptDraft(this.#session)
      if (draft === '') {
        if (++consecutiveEmpty >= 2) return
      } else {
        consecutiveEmpty = 0
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  #hold(reason, text) {
    const detail = {
      draft: 'you have an unsent draft in the prompt box',
      'copy-mode': 'the pane is in tmux copy mode - press q to leave it',
      error: 'the write failed',
    }[reason] ?? `pane is ${reason}`
    console.log(`[inject] held: ${reason}`)
    this.#notifyHost(`c2c: HELD a guest message, ${detail}`)
    this.#broadcastJson({ type: 'policy:held', state: reason, text })
    return false
  }

  #onPolicyEvent(event) {
    if (event.type === 'approved') {
      this.#inject(event.text)
      this.#notifyHost(`c2c: released #${event.id} from ${event.guest}`)
    }
    if (event.type === 'denied') {
      this.#notifyHost(`c2c: dropped #${event.id} from ${event.guest}`)
    }
    if (event.type === 'queued') {
      this.#notifyHost(`c2c: ${event.guest} wants to send #${event.id} - prefix+a to release`)
    }
    if (event.type === 'mode') {
      this.#notifyHost(`c2c: mode is now ${event.mode}`)
    }
    this.#broadcastJson({ ...event, type: `policy:${event.type}` })
    this.#writeStatusLine()
  }

  #notifyHost(message) {
    tmux.notify(this.#session, message)
  }

  // Kept in a file so the tmux status line is a cheap cat rather than a node
  // process spawned every couple of seconds.
  async #writeStatusLine() {
    const pending = this.#policy.list().length
    const guests = this.#guests.size
    const mode = this.#policy.mode === RING ? '#[fg=#ff2e4c,bold]RING' : '#[fg=#ffd93d]gallery'

    const parts = [
      `#[fg=#9a90b0]c2c ${mode}#[default]`,
      `#[fg=#9a90b0]${guests} guest${guests === 1 ? '' : 's'}`,
    ]
    if (pending) {
      parts.push(`#[fg=#ffd93d,bold]${pending} waiting#[default] #[fg=#9a90b0](prefix+a approve, prefix+d deny)`)
    }

    try {
      await writeFile(statusFile(this.#session), parts.join(' #[fg=#362c4a]|#[default] ') + ' ')
    } catch {}
  }

  #broadcastJson(value) {
    for (const transport of this.#transports) transport.broadcastJson(value)
  }

  async #startControl() {
    const path = controlSocket(this.#session)
    try {
      await unlink(path)
    } catch {}

    this.#control = createUnixServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          let reply
          try {
            reply = this.#handleControl(JSON.parse(line))
          } catch (err) {
            reply = { ok: false, error: err.message }
          }
          socket.write(JSON.stringify(reply) + '\n')
        }
      })
      socket.on('error', () => {})
    })

    await new Promise((resolve, reject) => {
      this.#control.once('error', reject)
      this.#control.listen(path, resolve)
    })
  }

  #handleControl(msg) {
    switch (msg.cmd) {
      case 'status':
        return {
          ok: true,
          session: this.#session,
          mode: this.#policy.mode,
          guests: [...this.#guests.values()].map((g) => ({ id: g.id, name: g.name, via: g.origin })),
          pending: this.#policy.list(),
          url: this.url,
          bigtop: this.bigtop
            ? { url: this.bigtop.guestUrl, connected: this.bigtop.connected, last: this.#bigtopStatus }
            : null,
        }
      case 'mode': {
        const next = msg.mode === 'toggle'
          ? (this.#policy.mode === RING ? GALLERY : RING)
          : msg.mode
        return { ok: true, mode: this.#policy.setMode(next) }
      }
      case 'approve-next':
      case 'deny-next': {
        const [oldest] = this.#policy.list()
        if (!oldest) {
          this.#notifyHost('c2c: nothing waiting')
          return { ok: true, pending: 0 }
        }
        const entry = msg.cmd === 'approve-next'
          ? this.#policy.approve(oldest.id)
          : this.#policy.deny(oldest.id)
        return { ok: true, [msg.cmd === 'approve-next' ? 'approved' : 'denied']: entry }
      }
      case 'list':
        return { ok: true, pending: this.#policy.list() }
      case 'approve': {
        const entry = this.#policy.approve(Number(msg.id))
        return entry ? { ok: true, approved: entry } : { ok: false, error: `no pending message ${msg.id}` }
      }
      case 'deny': {
        const entry = this.#policy.deny(Number(msg.id))
        return entry ? { ok: true, denied: entry } : { ok: false, error: `no pending message ${msg.id}` }
      }
      case 'approve-all':
        return { ok: true, approved: this.#policy.approveAll() }
      case 'deny-all':
        return { ok: true, denied: this.#policy.denyAll() }
      case 'stop':
        // Same courtesy the watchdog path gives: tell guests before going, and
        // clean up rather than exiting on the spot.
        this.announceEnd('the session ended')
        setTimeout(async () => {
          await this.stop()
          process.exit(0)
        }, 150)
        return { ok: true, stopping: true }
      default:
        return { ok: false, error: `unknown command: ${msg.cmd}` }
    }
  }
}

export { GALLERY }
