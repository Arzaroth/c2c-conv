import { createServer as createUnixServer } from 'node:net'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'
import { TranscriptStream } from './transcript.js'
import { Tunnel } from './tunnel.js'
import { Policy, GALLERY, YOLO, needsWhiteface } from './policy.js'
import { timingSafeEqualString } from './secret.js'
import { LocalTransport } from './transport/local.js'
import { BigtopTransport } from './transport/bigtop.js'
import { controlSocket, ensureStateDir, metaFile, paneFile, statusFile } from './paths.js'

const MAX_PANE_BYTES = Number(process.env.C2C_MAX_PANE_BYTES) || 8 * 1024 * 1024
const MAX_HISTORY = 500



export class Ringmaster {
  #session
  #token
  #policy = new Policy()
  #bozos = new Map()
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
  #tunnel = null
  #tunnelUrl = null
  #wantsTunnel = false
  #startMode = null
  #whitefaceToken = null
  #whiteface = null

  constructor({ session, port, host = '127.0.0.1', token, bigtop, tunnel = false, mode, whiteface }) {
    this.#wantsTunnel = tunnel
    this.#startMode = mode || null
    // A separate secret from the bozo token: leaking the share link must not
    // hand over control of the session with it.
    this.#whitefaceToken = whiteface || null
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

    if (this.#startMode) this.#policy.setMode(this.#startMode)
    this.#policy.onEvent((event) => this.#onPolicyEvent(event))

    for (const transport of this.#transports) {
      transport.on('bozo', (channel) => this.#onGuest(channel))
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

    // cloudflared connects out, so the ringmaster stays on loopback and there is
    // still nothing to forward. The tunnel is a child of this process so it dies
    // with the session rather than outliving it as a public URL.
    // Never awaited: cloudflared takes ten seconds or so to establish, and
    // blocking on it delays the metadata file that tells `c2c host` the session
    // is up. It concluded the ringmaster had failed and killed the session.
    if (this.#wantsTunnel) {
      this.#tunnel = new Tunnel({ port: this.local.port })
      this.#tunnel.on('closed', () => {
        this.#tunnelUrl = null
        console.log('[tunnel] cloudflared exited')
      })
      this.#tunnel
        .start()
        .then(async (url) => {
          this.#tunnelUrl = url
          console.log(`[tunnel] ${url}`)
          await this.#writeMeta()
        })
        .catch((err) => {
          console.error(`[tunnel] ${err.message}`)
          this.#tunnel = null
        })
    }

    this.#watchPaneState()
    await this.#writeStatusLine()

    await this.#startControl()
    await this.#writeMeta()
  }

  announce(text) {
    this.#broadcastJson({ type: 'notice', text })
  }

  // Distinct from a notice so bozos know not to keep reconnecting.
  announceEnd(text) {
    this.#broadcastJson({ type: 'bye', text })
  }

  async stop() {
    clearInterval(this.#stateTimer)
    this.#tunnel?.stop()
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
        // changes under bozos who would otherwise keep rendering the old grid.
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
  // written between stop and start, so bozos get a fresh snapshot afterwards
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

  // Prefer a URL a browser can actually reach from elsewhere.
  #bestUrl() {
    if (this.#tunnelUrl) return `${this.#tunnelUrl}/?t=${this.#token}`
    if (this.bigtop) return this.bigtop.bozoUrl
    return this.local.url
  }

  async #writeMeta() {
    await writeFile(metaFile(this.#session), JSON.stringify(this.#meta(), null, 2))
  }

  #meta() {
    const local = this.local
    return {
      session: this.#session,
      pid: process.pid,
      port: local.port,
      token: this.#token,
      url: local.url,
      bigtop: this.bigtop ? { url: this.bigtop.bozoUrl } : null,
      tunnel: this.#tunnelUrl ? `${this.#tunnelUrl}/?t=${this.#token}` : null,
      whiteface: Boolean(this.#whitefaceToken),
      whitefaceUrl: this.#whitefaceToken ? `${this.#bestUrl()}&w=${this.#whitefaceToken}` : null,
    }
  }

  async #onGuest(channel) {
    const bozo = { id: channel.id, name: 'bozo', origin: channel.origin, channel }
    this.#bozos.set(channel.id, bozo)

    channel.on('text', (raw) => this.#onGuestMessage(bozo, raw))
    channel.on('close', () => {
      this.#bozos.delete(channel.id)
      if (this.#whiteface === channel.id) {
        this.#whiteface = null
        this.#notifyHost('c2c: the whiteface left, the role is free again')
      }
      this.#writeStatusLine()
      this.#notifyHost(`c2c: ${bozo.name} left (${this.#bozos.size} connected)`)
    })

    // The bozo speaks first, with its name. Answering only once it has hoinked
    // means the host is told who arrived rather than that someone did.
  }

  #claimWhiteface(bozo, token) {
    if (!this.#whitefaceToken || !timingSafeEqualString(token, this.#whitefaceToken)) {
      bozo.channel.sendJson({ type: 'whiteface:refused', reason: 'bad token' })
      return
    }
    // One holder at a time. The token stays valid so a dropped connection can
    // reclaim the role, but nobody can take it from whoever holds it.
    if (this.#whiteface && this.#whiteface !== bozo.id && this.#bozos.has(this.#whiteface)) {
      bozo.channel.sendJson({ type: 'whiteface:refused', reason: 'someone else is the whiteface' })
      return
    }

    this.#whiteface = bozo.id
    bozo.whiteface = true
    bozo.channel.sendJson({ type: 'whiteface', you: true })
    this.#notifyHost(`c2c: ${bozo.name} is the whiteface now`)
    this.#writeStatusLine()
  }

  #runWhitefaceAction(msg) {
    if (msg.type === 'mode') {
      const next = msg.mode === 'toggle'
        ? (this.#policy.mode === YOLO ? GALLERY : YOLO)
        : msg.mode
      try {
        this.#policy.setMode(next)
      } catch {}
      return
    }
    if (msg.type === 'approve') this.#policy.approve(Number(msg.id))
    if (msg.type === 'deny') this.#policy.deny(Number(msg.id))
    if (msg.type === 'approve-next') {
      const [oldest] = this.#policy.list()
      if (oldest) this.#policy.approve(oldest.id)
    }
  }

  async #hoink(bozo, name) {
    if (typeof name === 'string') {
      bozo.name = name.slice(0, 40).replace(/[^\w .-]/g, '') || 'bozo'
    }

    const { cols, rows } = await tmux.paneSize(this.#session)
    bozo.channel.sendJson({
      type: 'hoink',
      mode: this.#policy.mode,
      state: this.#paneState,
      cols,
      rows,
      bozoId: bozo.id,
      name: bozo.name,
    })
    await this.#sendScreen(bozo.channel)
    if (this.#history.length) {
      bozo.channel.sendJson({ type: 'transcript:history', entries: this.#history })
    }
    this.#writeStatusLine()
    this.#notifyHost(`c2c: ${bozo.name} hoinked in via ${bozo.origin} (${this.#bozos.size} here)`)
  }

  #onGuestMessage(bozo, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'hoink') {
      this.#hoink(bozo, msg.name)
      if (msg.whiteface) this.#claimWhiteface(bozo, msg.whiteface)
      return
    }

    if (msg.type === 'whiteface') {
      this.#claimWhiteface(bozo, msg.token)
      return
    }

    // Everything below is host control, and only the whiteface may ask.
    if (needsWhiteface(msg.type)) {
      if (this.#whiteface !== bozo.id) {
        bozo.channel.sendJson({ type: 'whiteface:refused', action: msg.type })
        return
      }
      this.#runWhitefaceAction(msg)
      return
    }

    if (msg.type === 'name' && typeof msg.name === 'string') {
      bozo.name = msg.name.slice(0, 40).replace(/[^\w .-]/g, '') || 'bozo'
      bozo.channel.sendJson({ type: 'named', name: bozo.name })
      this.#writeStatusLine()
      return
    }

    // A browser bozo renders the live byte stream, so it only needs a snapshot
    // when it joins. A programmatic bozo has no terminal emulator and has to
    // be able to ask for the current screen.
    if (msg.type === 'refresh') {
      this.#sendScreen(bozo.channel)
      return
    }

    if (msg.type === 'key') {
      const result = this.#policy.submitKey({ key: msg.key, bozo: bozo.name })
      if (result.action === 'send') this.#pressKey(result.key)
      else bozo.channel.sendJson({ type: 'key:refused', key: msg.key, reason: result.reason })
      return
    }

    if (msg.type === 'submit') {
      const result = this.#policy.submit({ text: msg.text, bozo: bozo.name })
      if (result.action === 'send') {
        this.#inject(result.text)
        bozo.channel.sendJson({ type: 'accepted', text: result.text })
      } else if (result.action === 'queued') {
        bozo.channel.sendJson({ type: 'pending', id: result.id, text: msg.text })
      } else if (result.action === 'rejected') {
        bozo.channel.sendJson({ type: 'rejected', reason: result.reason })
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
        // A bozo message disappearing without a trace is the worst possible
        // failure here, so a broken write is loud on both sides.
        console.error(`[inject] failed: ${err?.message ?? err}`)
        this.#notifyHost(`c2c: FAILED to deliver a bozo message - ${err?.message ?? err}`)
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
    this.#notifyHost(`c2c: HELD a bozo message, ${detail}`)
    this.#broadcastJson({ type: 'policy:held', state: reason, text })
    return false
  }

  #onPolicyEvent(event) {
    if (event.type === 'approved') {
      this.#inject(event.text)
      this.#notifyHost(`c2c: released #${event.id} from ${event.bozo}`)
    }
    if (event.type === 'denied') {
      this.#notifyHost(`c2c: dropped #${event.id} from ${event.bozo}`)
    }
    if (event.type === 'queued') {
      this.#notifyHost(`c2c: ${event.bozo} wants to send #${event.id} - prefix+a to release`)
    }
    if (event.type === 'mode') {
      this.#notifyHost(`c2c: mode is now ${event.mode}`)
    }
    // What is waiting goes to the whiteface only. Another bozo's unreleased
    // message is not the rest of the gallery's business, especially one the
    // host is about to drop.
    if (event.type === 'queued') this.#toWhiteface({ ...event, type: 'policy:queued' })
    else this.#broadcastJson({ ...event, type: `policy:${event.type}` })
    this.#writeStatusLine()
  }

  #notifyHost(message) {
    tmux.notify(this.#session, message)
  }

  // Kept in a file so the tmux status line is a cheap cat rather than a node
  // process spawned every couple of seconds.
  async #writeStatusLine() {
    const pending = this.#policy.list().length
    const bozos = this.#bozos.size
    const mode = this.#policy.mode === YOLO ? '#[fg=#ff2e4c,bold]YOLO' : '#[fg=#ffd93d]gallery'

    const parts = [
      `#[fg=#9a90b0]c2c ${mode}#[default]`,
      `#[fg=#9a90b0]${bozos} bozo${bozos === 1 ? '' : 's'}`,
    ]
    if (pending) {
      parts.push(`#[fg=#ffd93d,bold]${pending} waiting#[default] #[fg=#9a90b0](prefix+a approve, prefix+d deny)`)
    }

    try {
      await writeFile(statusFile(this.#session), parts.join(' #[fg=#362c4a]|#[default] ') + ' ')
    } catch {}
  }

  #toWhiteface(value) {
    const holder = this.#whiteface && this.#bozos.get(this.#whiteface)
    if (holder && !holder.channel.closed) holder.channel.sendJson(value)
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
          bozos: [...this.#bozos.values()].map((g) => ({ id: g.id, name: g.name, via: g.origin })),
          pending: this.#policy.list(),
          url: this.url,
          tunnel: this.#tunnelUrl ? `${this.#tunnelUrl}/?t=${this.#token}` : null,
      whiteface: Boolean(this.#whitefaceToken),
      whitefaceUrl: this.#whitefaceToken ? `${this.#bestUrl()}&w=${this.#whitefaceToken}` : null,
          bigtop: this.bigtop
            ? { url: this.bigtop.bozoUrl, connected: this.bigtop.connected, last: this.#bigtopStatus }
            : null,
        }
      case 'mode': {
        const next = msg.mode === 'toggle'
          ? (this.#policy.mode === YOLO ? GALLERY : YOLO)
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
        // Same courtesy the watchdog path gives: tell bozos before going, and
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
