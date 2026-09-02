// The wire between the ringmaster, the transports and the browser bozo. Shared
// by both builds: no imports or exports here, so everything is ambient and the
// web client can use it without a module loader.

type Mode = 'gallery' | 'yolo'

// What the pane is doing, as far as the ringmaster can tell from a capture.
type PaneState = 'dead' | 'copy-mode' | 'dialog' | 'busy' | 'prompt' | 'unknown'

// Why an injection did not land. 'draft' and 'error' are not pane states: the
// pane was fine, the write was not.
type HoldReason = PaneState | 'draft' | 'error'

interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  tools?: string[]
  at?: string
}

interface PendingEntry {
  id: number
  text: string
  bozo?: string
  at: number
}

// What the outbox does with a message once it is cleared to go: drain waits for
// the session to be idle and sends one at a time, through types into a busy
// pane and lets claude queue it.
type OutboxMode = 'drain' | 'through'

// sending means it is going down the wire right now, which is also why it can
// no longer be cancelled. reason says why a waiting one is not moving.
interface OutboxEntry {
  id: number
  text: string
  bozo?: string
  at: number
  state: 'waiting' | 'sending'
  reason?: HoldReason
}

// A line in the farce-to-farce lane. host marks the ones typed at the terminal
// with c2c say rather than in a browser.
interface F2fMessage {
  id: number
  from: string
  text: string
  at: number
  host?: boolean
}

interface CursorPosition {
  x: number
  y: number
}

interface PaneSize {
  cols: number
  rows: number
}

/* ── policy ─────────────────────────────────────────────────────────────── */

type SubmitResult =
  | { action: 'ignored' }
  | { action: 'rejected'; reason: string }
  | { action: 'send'; text: string }
  | { action: 'queued'; id: number }

type KeyResult =
  | { action: 'rejected'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'send'; key: string }

type PolicyEvent =
  | { type: 'mode'; mode: Mode }
  | { type: 'sent'; text: string; bozo?: string }
  | { type: 'key'; key: string; bozo?: string }
  | ({ type: 'queued' | 'approved' | 'denied' } & PendingEntry)

/* ── the control dispatcher ─────────────────────────────────────────────── */

// One vocabulary, two ways in: the unix socket behind c2c ctl, and a whiteface
// asking over its bozo socket. WHITEFACE_COMMANDS says which of these the
// second is allowed.
type ControlCommand =
  | 'status' | 'list' | 'mode' | 'stop' | 'say'
  | 'approve' | 'deny' | 'approve-next' | 'deny-next' | 'approve-all' | 'deny-all'
  | 'outbox' | 'cancel' | 'cancel-all' | 'bump'

// status carries the token and stop ends the session: those two stay with
// c2c ctl and are never reachable from a browser. say is the host's way into
// the f2f lane from the terminal, and a browser already has the lane itself.
type WhitefaceCommand = Exclude<ControlCommand, 'status' | 'stop' | 'say'>

type ControlRequest =
  | {
      cmd: 'status' | 'list' | 'stop' | 'approve-next' | 'deny-next' | 'approve-all' | 'deny-all'
        | 'outbox' | 'cancel-all'
    }
  | { cmd: 'mode'; mode: string }
  | { cmd: 'say'; text: string }
  | { cmd: 'approve' | 'deny' | 'cancel' | 'bump'; id: number | string }

// The three links a browser might be handed. Spread into both the metadata
// file and a status reply, so they are described once.
interface SessionLinks {
  url: string
  tunnel: string | null
  whitefaceUrl: string | null
}

interface StatusReply extends SessionLinks {
  ok: true
  session: string
  mode: Mode
  outboxMode: OutboxMode
  bozos: { id: string; name: string; via: string }[]
  pending: PendingEntry[]
  outbox: OutboxEntry[]
  bigtop: { url: string; connected: boolean; last: BigtopStatus | null } | null
}

interface ActionReply {
  ok: true
  mode?: Mode
  pending?: number | PendingEntry[]
  approved?: PendingEntry | PendingEntry[] | null
  denied?: PendingEntry | PendingEntry[] | null
  outbox?: OutboxEntry[]
  cancelled?: OutboxEntry | OutboxEntry[] | null
  bumped?: OutboxEntry | null
  said?: F2fMessage
  stopping?: boolean
}

type ControlReply = StatusReply | ActionReply | { ok: false; error: string }

/* ── ringmaster to bozo ─────────────────────────────────────────────────── */

// Every policy event is rebroadcast under a policy: prefix so a bozo can tell
// the gate's decisions apart from the session's own traffic.
type PolicyBroadcast =
  | { type: 'policy:mode'; mode: Mode }
  | { type: 'policy:sent'; text: string; bozo?: string }
  | { type: 'policy:key'; key: string; bozo?: string }
  | ({ type: 'policy:queued' | 'policy:approved' | 'policy:denied' } & PendingEntry)

type ServerMessage =
  // The greeting also settles the role, and the holder gets the queue with it:
  // a whiteface reconnecting after messages piled up sees them straight away.
  | {
      type: 'hoink'
      mode: Mode
      state: PaneState
      cols: number
      rows: number
      bozoId: string
      name: string
      whiteface: boolean
      pending?: PendingEntry[]
      outbox: OutboxEntry[]
      outboxMode: OutboxMode
      f2f: F2fMessage[]
    }
  | { type: 'screen'; data: string; cursor: CursorPosition }
  | { type: 'state'; state: PaneState }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'named'; name: string }
  | { type: 'accepted'; text: string }
  | { type: 'pending'; id: number; text: string; bozo?: string }
  | { type: 'rejected'; reason: string }
  | { type: 'key:refused'; key: string; reason: string }
  | { type: 'whiteface:refused'; reason: string }
  // A control command answered over the bozo socket, carrying the dispatcher's
  // own reply so the browser needs no second vocabulary.
  | ({ type: 'control'; cmd: string } & ControlReply)
  | { type: 'policy:held'; state: HoldReason; text: string }
  // The whole line every time it changes rather than a delta per entry: it is
  // fifty short strings at the very most, and a queue that disagrees with the
  // one the host is looking at is worse than the bytes are worth.
  | { type: 'outbox'; entries: OutboxEntry[]; mode: OutboxMode }
  | { type: 'f2f'; msg: F2fMessage }
  | { type: 'notice'; text: string }
  | { type: 'bye'; text: string }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'transcript:history'; entries: TranscriptEntry[] }
  | PolicyBroadcast

/* ── bozo to ringmaster ─────────────────────────────────────────────────── */

// Parsed from an untrusted socket, so every field is still checked at runtime
// before it is used. This says what a well-behaved bozo sends, not what arrived.
type BozoMessage =
  | { type: 'hoink'; name?: string; whiteface?: string }
  | { type: 'name'; name?: string }
  | { type: 'refresh' }
  | { type: 'key'; key: string }
  | { type: 'submit'; text: string }
  | { type: 'f2f'; text: string }
  // The whiteface half of the vocabulary, shaped like a control request minus
  // the cmd key, which the ringmaster fills in from the type.
  | { type: 'list' | 'approve-next' | 'deny-next' | 'approve-all' | 'deny-all' }
  | { type: 'outbox' | 'cancel-all' }
  | { type: 'mode'; mode: Mode | 'toggle' }
  | { type: 'approve' | 'deny' | 'cancel' | 'bump'; id: number | string }

/* ── transports ─────────────────────────────────────────────────────────── */

// One bozo, whichever way it got here: a socket this process accepted, or a
// slot in the single uplink a bigtop multiplexes.
interface Channel {
  readonly id: string
  readonly origin: string
  readonly closed: boolean
  sendJson(value: ServerMessage): void
  sendBinary(chunk: Uint8Array): void
  close(): void
  on(event: 'text', listener: (raw: string) => void): this
  on(event: 'close', listener: () => void): this
}

interface BigtopStatus {
  connected: boolean
  room?: string
  code?: number
  reason?: string
  hint?: string
  error?: string
}

interface Transport {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  broadcastBinary(chunk: Uint8Array): void
  broadcastJson(value: ServerMessage): void
  on(event: 'bozo', listener: (channel: Channel) => void): this
  on(event: 'status', listener: (status: BigtopStatus) => void): this
}

// The envelope on the single socket between a host and a bigtop. Broadcasts go
// out once rather than once per bozo, so a target has to travel with them.
type UplinkFrame =
  | { to: string; payload: ServerMessage }
  | { to: string; bin: string }
  | { to: string; evict: true }

type DownlinkFrame =
  | { from: string; event: 'join' | 'leave' }
  | { from: string; event: 'message'; payload: BozoMessage }

/* ── the metadata file ──────────────────────────────────────────────────── */

interface SessionMeta extends SessionLinks {
  session: string
  pid: number
  port: number
  token: string
  bigtop: { url: string } | null
}
