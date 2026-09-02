import { createServer as createUnixServer, type Server as UnixServer } from 'node:net'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'
import { TranscriptStream } from './transcript.js'
import { Tunnel } from './tunnel.js'
import { Policy, GALLERY, YOLO } from './policy.js'
import { Outbox, type OutboxEvent, type SendOutcome } from './outbox.js'
import { Farce } from './f2f.js'
import { Whiteface, isWhitefaceCommand } from './whiteface.js'
import { LocalTransport } from './transport/local.js'
import { BigtopTransport } from './transport/bigtop.js'
import { controlSocket, ensureStateDir, metaFile, paneFile, statusFile } from './paths.js'

const MAX_PANE_BYTES = Number(process.env.C2C_MAX_PANE_BYTES) || 8 * 1024 * 1024
const MAX_HISTORY = 500

// How far back the scrollback view reaches when a bozo does not say.
const DEFAULT_SCROLLBACK = 5000

// How much of the f2f lane a bozo gets on arrival. The rest stays on the
// ringmaster: the greeting is not the place to ship a whole afternoon of chat.
const F2F_GREETING = 50

// A browser tells the room it is typing at most this often. The relay is
// throttled here as well as there: a bozo is not obliged to behave.
const TYPING_MS = 2000

// Why a message is sitting in the outbox instead of going in, in words the
// person who sent it can act on.
export function holdText(reason: HoldReason): string {
  const reasons: Partial<Record<HoldReason, string>> = {
    draft: 'the host has an unsent draft in the prompt box',
    busy: 'the session is still working',
    dialog: 'the session is waiting on a dialog',
    'copy-mode': 'the pane is in tmux copy mode - press q to leave it',
    unknown: 'the session is not at a prompt',
    dead: 'the pane is gone',
    error: 'the write failed',
  }
  return reasons[reason] ?? `the pane is ${reason}`
}

// c2c ctl cancel takes the id as it is printed, which is o-prefixed so an
// outbox id is never mistaken for a pending one.
function outboxId(id: number | string): number {
  return Number(String(id).replace(/^o/i, ''))
}

interface RingmasterOptions {
  session: string
  port: number
  host?: string
  token?: string
  bigtop?: { url: string; room: string; token?: string } | null
  tunnel?: boolean
  mode?: string
  whiteface?: string
  outboxMode?: OutboxMode
}

export interface Bozo {
  id: string
  name: string
  origin: string
  channel: Channel
  since: number
  // Connected is not the same as watching. A browser that is hidden or has been
  // left alone says so, and the roster shows it, because a line typed into a
  // lane nobody is reading looks exactly like one that was read.
  idle: boolean
  typingAt?: number
}

export class Ringmaster {
  #session: string
  #token: string
  #policy = new Policy()
  #outbox: Outbox
  #farce = new Farce()
  #bozos = new Map<string, Bozo>()
  #transports: Transport[] = []
  #local: LocalTransport
  #bigtop: BigtopTransport | null = null
  #pane: PaneStream | null = null
  #control: UnixServer | null = null
  #bigtopStatus: BigtopStatus | null = null
  #paneState: PaneState = 'unknown'
  #paneSize: PaneSize = { cols: 0, rows: 0 }
  #stateTimer: NodeJS.Timeout | undefined
  #transcript: TranscriptStream | null = null
  #history: TranscriptEntry[] = []
  #tunnel: Tunnel | null = null
  #tunnelUrl: string | null = null
  #wantsTunnel = false
  #whiteface: Whiteface<Bozo>

  constructor(
    { session, port, host = '127.0.0.1', token, bigtop, tunnel = false, mode, whiteface, outboxMode }:
    RingmasterOptions,
  ) {
    this.#wantsTunnel = tunnel
    this.#outbox = new Outbox({ mode: outboxMode, send: (entry) => this.#deliver(entry) })
    this.#whiteface = new Whiteface<Bozo>(whiteface)
    if (mode) this.#policy.setMode(mode)
    this.#session = session
    this.#token = token || randomBytes(16).toString('hex')

    this.#local = new LocalTransport({ port, host, token: this.#token })
    this.#transports.push(this.#local)

    if (bigtop?.url) {
      this.#bigtop = new BigtopTransport({
        url: bigtop.url,
        room: bigtop.room,
        token: bigtop.token || this.#token,
      })
      this.#transports.push(this.#bigtop)
    }
  }

  get token(): string {
    return this.#token
  }

  get local(): LocalTransport {
    return this.#local
  }

  get bigtop(): BigtopTransport | null {
    return this.#bigtop
  }

  get url(): string {
    return this.#local.url
  }

  get policy(): Policy {
    return this.#policy
  }

  get outbox(): Outbox {
    return this.#outbox
  }

  async start(): Promise<void> {
    await ensureStateDir(this.#session)
    await writeFile(paneFile(this.#session), '')
    await tmux.startPipe(this.#session, paneFile(this.#session))

    this.#pane = new PaneStream(paneFile(this.#session))
    this.#pane.on('data', (chunk: Buffer) => {
      for (const transport of this.#transports) transport.broadcastBinary(chunk)
    })
    await this.#pane.start()

    this.#policy.onEvent((event) => this.#onPolicyEvent(event))
    this.#outbox.onEvent((event) => this.#onOutboxEvent(event))

    for (const transport of this.#transports) {
      transport.on('bozo', (channel: Channel) => this.#onGuest(channel))
      transport.on('status', (status: BigtopStatus) => {
        this.#bigtopStatus = status
        console.log(`[bigtop] ${JSON.stringify(status)}`)
      })
      await transport.start()
    }

    this.#transcript = new TranscriptStream(this.#session)
    this.#transcript.on('entry', (entry: TranscriptEntry) => {
      this.#history.push(entry)
      if (this.#history.length > MAX_HISTORY) this.#history.shift()
      this.#broadcastJson({ type: 'transcript', entry })
    })
    this.#transcript.on('located', (info: { path: string }) => console.log(`[transcript] ${info.path}`))
    this.#transcript.start()

    // cloudflared connects out, so the ringmaster stays on loopback and there is
    // still nothing to forward. The tunnel is a child of this process so it dies
    // with the session rather than outliving it as a public URL.
    // Never awaited: cloudflared takes ten seconds or so to establish, and
    // blocking on it delays the metadata file that tells `c2c host` the session
    // is up. It concluded the ringmaster had failed and killed the session.
    if (this.#wantsTunnel) {
      this.#tunnel = new Tunnel({ port: this.#local.port })
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
        .catch((err: Error) => {
          console.error(`[tunnel] ${err.message}`)
          this.#tunnel = null
        })
    }

    this.#watchPaneState()
    await this.#writeStatusLine()

    await this.#startControl()
    await this.#writeMeta()
  }

  announce(text: string): void {
    this.#broadcastJson({ type: 'notice', text })
  }

  // Distinct from a notice so bozos know not to keep reconnecting.
  announceEnd(text: string): void {
    this.#broadcastJson({ type: 'bye', text })
  }

  async stop(): Promise<void> {
    clearInterval(this.#stateTimer)
    this.#outbox.stop()
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

  #watchPaneState(): void {
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

  async #screenMessage(): Promise<ServerMessage> {
    return {
      type: 'screen',
      data: await tmux.capturePane(this.#session),
      cursor: await tmux.cursor(this.#session),
    }
  }

  async #reseed(): Promise<void> {
    this.#broadcastJson(await this.#screenMessage())
  }

  async #sendScreen(channel: Channel): Promise<void> {
    if (!channel.closed) channel.sendJson(await this.#screenMessage())
  }

  // pipe-pane appends for the lifetime of the session. Rotating loses the bytes
  // written between stop and start, so bozos get a fresh snapshot afterwards
  // rather than a stream with a hole in it.
  async #rotatePaneFile(): Promise<void> {
    const file = paneFile(this.#session)
    const { size } = await stat(file)
    if (size < MAX_PANE_BYTES) return

    await tmux.stopPipe(this.#session)
    await writeFile(file, '')
    this.#pane?.rewind()
    await tmux.startPipe(this.#session, file)
    await this.#reseed()
  }

  #links(): SessionLinks {
    const tunnel = this.#tunnelUrl ? `${this.#tunnelUrl}/?t=${this.#token}` : null
    // The whiteface link goes on whichever URL a browser can reach from elsewhere.
    const reach = tunnel ?? this.#bigtop?.bozoUrl ?? this.#local.url
    return {
      url: this.#local.url,
      tunnel,
      whitefaceUrl: this.#whiteface.enabled ? `${reach}&w=${this.#whiteface.token}` : null,
    }
  }

  async #writeMeta(): Promise<void> {
    await writeFile(metaFile(this.#session), JSON.stringify(this.#meta(), null, 2))
  }

  #meta(): SessionMeta {
    const local = this.#local
    return {
      session: this.#session,
      pid: process.pid,
      port: local.port,
      token: this.#token,
      ...this.#links(),
      bigtop: this.#bigtop ? { url: this.#bigtop.bozoUrl } : null,
    }
  }

  // Who is in the circus. mode is each bozo's own, which is the room default
  // until the host trusts one of them personally. Everything here goes to
  // everyone: via is a transport rather than an address, so the roster carries
  // nothing about a bozo that the rest of the room may not see.
  #roster(): RosterEntry[] {
    return [...this.#bozos.values()].map((bozo) => ({
      id: bozo.id,
      name: bozo.name,
      mode: this.#policy.modeFor(bozo.id),
      trusted: this.#policy.trustedMode(bozo.id) !== null,
      whiteface: this.#whiteface.holds(bozo),
      idle: bozo.idle,
      since: bozo.since,
      via: bozo.origin,
    }))
  }

  #sendRoster(): void {
    this.#broadcastJson({ type: 'roster', mode: this.#policy.mode, bozos: this.#roster() })
  }

  // policy:mode says what THIS bozo may do. With trust being per bozo there is
  // no single room-wide answer to broadcast, and the room default rides the
  // roster instead.
  #tellMode(bozo: Bozo): void {
    bozo.channel.sendJson({ type: 'policy:mode', mode: this.#policy.modeFor(bozo.id) })
  }

  // Names are what a bozo calls itself and two of them can be "bozo", so a name
  // that matches more than one is refused rather than guessed at. The id is
  // always unambiguous, and c2c ctl status prints it next to the name.
  #findBozos(who: unknown): Bozo[] {
    const needle = String(who ?? '').trim().toLowerCase()
    if (!needle) return []
    const all = [...this.#bozos.values()]
    const byId = all.filter((bozo) => bozo.id.toLowerCase() === needle)
    return byId.length ? byId : all.filter((bozo) => bozo.name.toLowerCase() === needle)
  }

  // Every command that acts on one bozo takes the name a human would use, so
  // the ambiguity is resolved once, here.
  #pickBozo(who: unknown): { ok: true; bozo: Bozo } | { ok: false; error: string } {
    const found = this.#findBozos(who)
    if (!found.length) return { ok: false, error: `nobody here called "${who}"` }
    if (found.length > 1) {
      const ids = found.map((bozo) => bozo.id).join(', ')
      return { ok: false, error: `${found.length} bozos called "${who}" - pick one by id: ${ids}` }
    }
    return { ok: true, bozo: found[0] }
  }

  #show(bozo: Bozo, text: string): void {
    // bye rather than a notice: it is what tells a browser to stop reconnecting,
    // and a bozo that reconnects on a dead token learns nothing from the 401.
    bozo.channel.sendJson({ type: 'bye', text })
    bozo.channel.close()
  }

  // The link is the whole credential, so the only way to take one back is to
  // change what is behind it. Everyone is put out and every URL handed round
  // stops working, the whiteface's included: its secret is separate, and it
  // would otherwise survive the new share link being sent to the same people.
  #rotate(): SessionMeta {
    // Everyone is put out first. Rotating the bigtop's token drops the uplink,
    // and a bye sent after that reaches nobody: the room's bozos would get the
    // server's own "host disconnected" instead and keep retrying a dead link.
    for (const bozo of [...this.#bozos.values()]) {
      this.#show(bozo, 'the host reset the link - ask them for the new one')
    }

    this.#token = randomBytes(16).toString('hex')
    this.#local.setToken(this.#token)
    this.#bigtop?.setToken(this.#token)
    if (this.#whiteface.enabled) this.#whiteface.rotate(randomBytes(16).toString('hex'))

    this.#notifyHost('c2c: the link was reset - the old one no longer works')
    this.#writeMeta()
    this.#writeStatusLine()
    return this.#meta()
  }

  async #onGuest(channel: Channel): Promise<void> {
    const bozo: Bozo = {
      id: channel.id,
      name: 'bozo',
      origin: channel.origin,
      channel,
      since: Date.now(),
      idle: false,
    }
    this.#bozos.set(channel.id, bozo)

    channel.on('text', (raw: string) => this.#onGuestMessage(bozo, raw))
    channel.on('close', () => {
      this.#bozos.delete(channel.id)
      // Trust was for the person on the other end of THIS socket. Whoever comes
      // back on the next one is in the gallery until the host says otherwise.
      this.#policy.forget(bozo.id)
      if (this.#whiteface.release(bozo)) {
        this.#notifyHost('c2c: the whiteface left, the role is free again')
      }
      this.#writeStatusLine()
      this.#sendRoster()
      this.#notifyHost(`c2c: ${bozo.name} left (${this.#bozos.size} connected)`)
    })

    // The bozo speaks first, with its name. Answering only once it has hoinked
    // means the host is told who arrived rather than that someone did.
  }

  // The greeting is also where the whiteface is claimed, so the reply carries
  // the role and, for the holder, the queue as it stands. A whiteface that
  // reconnects after messages piled up sees them straight away.
  async #hoink(bozo: Bozo, { name, whiteface: token }: { name?: unknown; whiteface?: string }): Promise<void> {
    if (typeof name === 'string') {
      bozo.name = name.slice(0, 40).replace(/[^\w .-]/g, '') || 'bozo'
    }
    const claim = token === undefined ? null : this.#whiteface.claim(bozo, token)
    if (claim?.ok) this.#notifyHost(`c2c: ${bozo.name} is the whiteface now`)
    const whiteface = this.#whiteface.holds(bozo)

    const { cols, rows } = await tmux.paneSize(this.#session)
    bozo.channel.sendJson({
      type: 'hoink',
      mode: this.#policy.modeFor(bozo.id),
      state: this.#paneState,
      cols,
      rows,
      bozoId: bozo.id,
      name: bozo.name,
      whiteface,
      pending: whiteface ? this.#policy.list() : undefined,
      // The outbox is everyone's business: a bozo waiting on the queue should
      // be able to see the queue. What is still held at the gate is not.
      outbox: this.#outbox.list(),
      outboxMode: this.#outbox.mode,
      f2f: this.#farce.history(F2F_GREETING),
    })
    if (claim && !claim.ok) {
      bozo.channel.sendJson({ type: 'whiteface:refused', reason: claim.reason })
    }
    await this.#sendScreen(bozo.channel)
    if (this.#history.length) {
      bozo.channel.sendJson({ type: 'transcript:history', entries: this.#history })
    }
    // Everyone, including whoever just arrived: one code path, and the room
    // finds out somebody is here at the same moment they do.
    this.#sendRoster()
    this.#writeStatusLine()
    this.#notifyHost(`c2c: ${bozo.name} hoinked in via ${bozo.origin} (${this.#bozos.size} here)`)
  }

  #onGuestMessage(bozo: Bozo, raw: string): void {
    // Off an untrusted socket: this says what the shape claims to be, and every
    // field is still checked before it is used.
    let msg: BozoMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'hoink') {
      this.#hoink(bozo, msg)
      return
    }

    // Host control, run through the same dispatcher as c2c ctl. The gate is
    // here rather than in the UI: a bozo opening its own socket and asking to
    // approve is refused exactly the same.
    if (isWhitefaceCommand(msg.type)) {
      const reply: ControlReply = this.#whiteface.holds(bozo)
        ? this.#handleControl({ ...msg, cmd: msg.type } as ControlRequest)
        : { ok: false, error: 'not the whiteface' }
      bozo.channel.sendJson({ type: 'control', cmd: msg.type, ...reply })
      return
    }

    if (msg.type === 'name' && typeof msg.name === 'string') {
      bozo.name = msg.name.slice(0, 40).replace(/[^\w .-]/g, '') || 'bozo'
      bozo.channel.sendJson({ type: 'named', name: bozo.name })
      this.#writeStatusLine()
      this.#sendRoster()
      return
    }

    // Presence. Only a change is worth a roster, or thirty browsers ticking
    // every twenty seconds would be thirty rosters a minute for nothing.
    if (msg.type === 'here') {
      const idle = Boolean(msg.idle)
      if (bozo.idle !== idle) {
        bozo.idle = idle
        this.#sendRoster()
      }
      return
    }

    // Typing is relayed and then forgotten: no state is kept here, and the
    // browsers that receive it time it out on their own.
    if (msg.type === 'typing') {
      const now = Date.now()
      if (bozo.typingAt && now - bozo.typingAt < TYPING_MS) return
      bozo.typingAt = now
      for (const other of this.#bozos.values()) {
        if (other !== bozo) other.channel.sendJson({ type: 'typing', bozo: bozo.id, name: bozo.name })
      }
      return
    }

    // A browser bozo renders the live byte stream, so it only needs a snapshot
    // when it joins. A programmatic bozo has no terminal emulator and has to
    // be able to ask for the current screen.
    if (msg.type === 'refresh') {
      this.#sendScreen(bozo.channel)
      return
    }

    // Nothing in the f2f lane goes near the pane, the policy or the transcript.
    // That is the whole feature: it is the one thing said in a shared session
    // that claude does not hear.
    if (msg.type === 'f2f') {
      bozo.typingAt = undefined
      this.#say(bozo.name, msg.text, false, typeof msg.nonce === 'string' ? msg.nonce.slice(0, 64) : undefined)
      return
    }

    if (msg.type === 'scrollback') {
      this.#sendScrollback(bozo.channel, msg.lines)
      return
    }

    if (msg.type === 'key') {
      const result = this.#policy.submitKey({
        key: msg.key,
        bozo: bozo.name,
        bozoId: bozo.id,
        whiteface: this.#whiteface.holds(bozo),
      })
      if (result.action === 'send') this.#pressKey(result.key)
      else bozo.channel.sendJson({ type: 'key:refused', key: msg.key, reason: result.reason })
      return
    }

    if (msg.type === 'submit') {
      const result = this.#policy.submit({ text: msg.text, bozo: bozo.name, bozoId: bozo.id })
      if (result.action === 'send') {
        bozo.channel.sendJson({ type: 'accepted', text: result.text })
      } else if (result.action === 'queued') {
        bozo.channel.sendJson({ type: 'pending', id: result.id, text: msg.text, bozo: bozo.name })
      } else if (result.action === 'rejected') {
        bozo.channel.sendJson({ type: 'rejected', reason: result.reason })
      }
    }
  }

  // Keys deliberately skip the prompt guard: answering a dialog is the whole
  // reason they exist. Digits go in as literal text so numbered menus work.
  async #pressKey(key: string): Promise<void> {
    if (/^[1-9]$/.test(key)) await tmux.sendText(this.#session, key)
    else await tmux.sendKey(this.#session, key)
  }

  // Cleared to send is not the same as sent. Everything goes into the outbox,
  // which is serial by construction, and only the head ever touches the pane -
  // two writers on one pty interleave. Keys deliberately skip the queue: they
  // are single atomic keystrokes and should not wait out a text injection.
  #enqueue(text: string, bozo?: string): void {
    if (this.#outbox.add({ text, bozo })) return
    console.error('[outbox] full, dropped a message')
    this.#notifyHost('c2c: the outbox is full - a message was dropped')
    this.#broadcastJson({ type: 'policy:held', state: 'error', text })
  }

  // Called by the outbox for the head of the queue, and only for the head.
  // A retry means "not yet", never "never": the message stays where it is and
  // everybody can see why. Only a dead pane or a failed write loses one.
  async #deliver(entry: OutboxEntry): Promise<SendOutcome> {
    const through = this.#outbox.mode === 'through'
    try {
      // In drain, waiting here rather than spinning: the common block is a turn
      // that takes minutes, and waitForPrompt already polls at a sane rate.
      const state = through ? await tmux.paneState(this.#session) : await tmux.waitForPrompt(this.#session)
      if (state === 'dead') return { ok: false, retry: false, reason: 'dead' }
      // through types into a working session on purpose: claude queues what is
      // typed mid-turn. A dialog or copy mode still swallows it, so those wait.
      if (state !== 'prompt' && !(through && state === 'busy')) {
        return { ok: false, retry: true, reason: state }
      }

      // The host typing is the other writer the queue cannot see.
      const draft = await tmux.promptDraft(this.#session)
      if (draft) return { ok: false, retry: true, reason: 'draft' }

      console.log(`[outbox] o${entry.id} sending: ${JSON.stringify(entry.text.slice(0, 40))}`)
      await tmux.submit(this.#session, entry.text)
      // Even in through, the next message must not catch this one still in the
      // box, or the two arrive spliced into one turn. The wait is shorter there
      // because a busy session may not be rendering the box at all, and then
      // there is nothing to see go empty.
      await this.#settle(through ? 1500 : 5000)
      console.log(`[outbox] o${entry.id} delivered`)
      return { ok: true }
    } catch (err) {
      // A message someone was told was sent, that never arrives, is the one
      // failure this design cannot afford. It is loud on both sides.
      console.error(`[outbox] o${entry.id} failed: ${(err as Error)?.message ?? err}`)
      return { ok: false, retry: false, reason: 'error' }
    }
  }

  // send-keys returns once tmux has queued the keys, well before the session
  // renders them, so a single "is the box empty" check passes while the text is
  // still in flight and the next queued message then catches it mid-render and
  // is held as a phantom draft. Wait for the box to read empty twice running.
  async #settle(timeoutMs = 5000): Promise<void> {
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

  #onOutboxEvent(event: OutboxEvent): void {
    if (event.type === 'changed') {
      this.#broadcastJson({ type: 'outbox', entries: this.#outbox.list(), mode: this.#outbox.mode })
      this.#writeStatusLine()
      return
    }
    if (event.type === 'waiting') {
      this.#notifyHost(`c2c: o${event.entry.id} is waiting - ${holdText(event.reason)}`)
    }
    if (event.type === 'failed') {
      this.#notifyHost(
        `c2c: FAILED to deliver o${event.entry.id} from ${event.entry.bozo} - ${holdText(event.reason)}`,
      )
      this.#broadcastJson({ type: 'policy:held', state: event.reason, text: event.entry.text })
    }
  }

  // Said between the clowns, never to the session.
  #say(from: string, text: unknown, host = false, nonce?: string): F2fMessage | null {
    const msg = this.#farce.say({ from, text, host })
    if (!msg) return null
    this.#broadcastJson({ type: 'f2f', msg, ...(nonce ? { nonce } : {}) })
    // The host at the terminal has no panel to read, so the lane arrives as a
    // tmux message. Their own lines are not echoed back at them.
    if (!host) this.#notifyHost(`f2f ${msg.from}: ${msg.text}`)
    return msg
  }

  async #sendScrollback(channel: Channel, lines: unknown): Promise<void> {
    const wanted = Number(lines) > 0 ? Number(lines) : DEFAULT_SCROLLBACK
    try {
      const data = await tmux.captureScrollback(this.#session, wanted)
      const { cols, rows } = await tmux.paneSize(this.#session)
      if (channel.closed) return
      channel.sendJson({ type: 'scrollback', data, cols, rows, lines: data.split('\n').length })
    } catch (err) {
      console.error(`[scrollback] ${(err as Error)?.message ?? err}`)
    }
  }

  #onPolicyEvent(event: PolicyEvent): void {
    // Both ways through the gate end in the same queue: yolo straight through,
    // gallery once the host releases it.
    if (event.type === 'sent') {
      this.#enqueue(event.text, event.bozo)
    }
    if (event.type === 'approved') {
      this.#enqueue(event.text, event.bozo)
      this.#notifyHost(`c2c: released #${event.id} from ${event.bozo}`)
    }
    if (event.type === 'denied') {
      this.#notifyHost(`c2c: dropped #${event.id} from ${event.bozo}`)
    }
    if (event.type === 'queued') {
      this.#notifyHost(`c2c: ${event.bozo} wants to send #${event.id} - prefix+a to release`)
    }

    // The two that are nobody else's business in the general case. A room
    // default reaches every bozo the host has not singled out; trust reaches
    // the one it is about. Both land as "here is what YOU may do", and the
    // roster carries the rest of the picture.
    if (event.type === 'mode') {
      this.#notifyHost(`c2c: the room is ${event.mode} by default now`)
      for (const bozo of this.#bozos.values()) {
        if (this.#policy.trustedMode(bozo.id) === null) this.#tellMode(bozo)
      }
      this.#sendRoster()
      this.#writeStatusLine()
      return
    }
    if (event.type === 'trust') {
      const bozo = this.#bozos.get(event.bozo)
      if (bozo) {
        this.#tellMode(bozo)
        this.#notifyHost(
          event.mode
            ? `c2c: ${bozo.name} is in ${event.mode} now, whatever the room does`
            : `c2c: ${bozo.name} is back on the room default (${this.#policy.mode})`,
        )
      }
      this.#sendRoster()
      this.#writeStatusLine()
      return
    }
    // What is waiting goes to the whiteface only. Another bozo's unreleased
    // message is not the rest of the gallery's business, especially one the
    // host is about to drop.
    if (event.type === 'queued') this.#whiteface.holder?.channel.sendJson({ ...event, type: 'policy:queued' })
    else this.#broadcastJson({ ...event, type: `policy:${event.type}` } as PolicyBroadcast)
    this.#writeStatusLine()
  }

  #notifyHost(message: string): void {
    tmux.notify(this.#session, message)
  }

  // Kept in a file so the tmux status line is a cheap cat rather than a node
  // process spawned every couple of seconds.
  async #writeStatusLine(): Promise<void> {
    const pending = this.#policy.list().length
    const outbox = this.#outbox.list().length
    const bozos = this.#bozos.size
    const mode = this.#policy.mode === YOLO ? '#[fg=#ff2e4c,bold]YOLO' : '#[fg=#ffd93d]gallery'
    // Whoever is in the ring against the room default is the thing the host
    // most needs on screen: in a gallery it is the only person who can act.
    const inRing = [...this.#bozos.values()]
      .filter((bozo) => this.#policy.modeFor(bozo.id) === YOLO).length

    const parts = [
      `#[fg=#9a90b0]c2c ${mode}#[default]`,
      `#[fg=#9a90b0]${bozos} bozo${bozos === 1 ? '' : 's'}`,
    ]
    if (inRing && this.#policy.mode !== YOLO) {
      parts.push(`#[fg=#ff2e4c,bold]${inRing} in the ring`)
    }
    if (pending) {
      parts.push(`#[fg=#ffd93d,bold]${pending} waiting#[default] #[fg=#9a90b0](prefix+a approve, prefix+d deny)`)
    }
    // Distinct from waiting on purpose: these are past the gate and only
    // waiting on the session itself, so there is nothing for the host to do.
    if (outbox) {
      parts.push(`#[fg=#3ddc84,bold]${outbox} in the outbox`)
    }

    try {
      await writeFile(statusFile(this.#session), parts.join(' #[fg=#362c4a]|#[default] ') + ' ')
    } catch {}
  }

  #broadcastJson(value: ServerMessage): void {
    for (const transport of this.#transports) transport.broadcastJson(value)
  }

  async #startControl(): Promise<void> {
    const path = controlSocket(this.#session)
    try {
      await unlink(path)
    } catch {}

    const control = createUnixServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          let reply: ControlReply
          try {
            reply = this.#handleControl(JSON.parse(line))
          } catch {
            reply = { ok: false, error: 'not json' }
          }
          socket.write(JSON.stringify(reply) + '\n')
        }
      })
      socket.on('error', () => {})
    })

    this.#control = control
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject)
      control.listen(path, resolve)
    })
  }

  // Never throws: both the control socket and the whiteface send the reply on.
  #handleControl(msg: ControlRequest): ControlReply {
    try {
      return this.#dispatchControl(msg)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  #dispatchControl(msg: ControlRequest): ControlReply {
    switch (msg.cmd) {
      case 'status':
        return {
          ok: true,
          session: this.#session,
          mode: this.#policy.mode,
          outboxMode: this.#outbox.mode,
          bozos: this.#roster(),
          pending: this.#policy.list(),
          outbox: this.#outbox.list(),
          ...this.#links(),
          bigtop: this.#bigtop
            ? { url: this.#bigtop.bozoUrl, connected: this.#bigtop.connected, last: this.#bigtopStatus }
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
        return msg.cmd === 'approve-next'
          ? { ok: true, approved: this.#policy.approve(oldest.id) }
          : { ok: true, denied: this.#policy.deny(oldest.id) }
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
      case 'outbox':
        return { ok: true, outbox: this.#outbox.list() }
      case 'cancel': {
        const result = this.#outbox.cancel(outboxId(msg.id))
        return result.ok ? { ok: true, cancelled: result.entry } : { ok: false, error: result.error }
      }
      case 'cancel-all':
        return { ok: true, cancelled: this.#outbox.cancelAll() }
      case 'bump': {
        const result = this.#outbox.bump(outboxId(msg.id))
        return result.ok ? { ok: true, bumped: result.entry } : { ok: false, error: result.error }
      }
      case 'say': {
        const said = this.#say('host', msg.text, true)
        return said ? { ok: true, said } : { ok: false, error: 'nothing to say' }
      }
      case 'kick': {
        const found = this.#pickBozo(msg.who)
        if (!found.ok) return found
        const { bozo } = found
        this.#show(bozo, 'the host closed your connection')
        this.#notifyHost(`c2c: kicked ${bozo.name}`)
        return { ok: true, kicked: { id: bozo.id, name: bozo.name } }
      }
      // Per bozo, so one person can be let into the ring without the other
      // twenty-nine coming with them. "default" is how they come back off it.
      case 'trust': {
        const found = this.#pickBozo(msg.who)
        if (!found.ok) return found
        const { bozo } = found
        if (msg.mode === 'default' || msg.mode === 'clear') {
          this.#policy.untrust(bozo.id)
          return { ok: true, trusted: { id: bozo.id, name: bozo.name, mode: null } }
        }
        const mode = this.#policy.trust(bozo.id, msg.mode)
        return { ok: true, trusted: { id: bozo.id, name: bozo.name, mode } }
      }
      case 'who':
        return { ok: true, mode: this.#policy.mode, bozos: this.#roster() }
      case 'rotate':
        return { ok: true, meta: this.#rotate() }
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
        return { ok: false, error: `unknown command: ${(msg as ControlRequest).cmd}` }
    }
  }
}

export { GALLERY }
