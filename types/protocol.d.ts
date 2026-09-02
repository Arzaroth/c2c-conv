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

// One line of the roster: who is in the circus, and what they are allowed to
// do. mode is that bozo's effective mode, which is the room default unless the
// host trusted them personally. via is which way they got in - a transport, not
// an address, so there is nothing here the room may not see.
interface RosterEntry {
  id: string
  name: string
  mode: Mode
  trusted: boolean
  whiteface: boolean
  idle: boolean
  since: number
  via: string
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
  // One bozo's trust was set or cleared. mode null means they are back on
  // whatever the room default happens to be.
  | { type: 'trust'; bozo: string; mode: Mode | null }
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
  | 'kick' | 'rotate' | 'trust' | 'who'

// status carries the token and stop ends the session: those two stay with
// c2c ctl and are never reachable from a browser. rotate is out for the same
// reason as status - it mints the new secret, the reply is the only place the
// new link exists, and it would cut the socket that asked for it. say is the
// host's way into the f2f lane from the terminal, and a browser already has
// the lane. kick and trust are in: the browser has a roster to pick a target
// from now, which is the thing that was missing.
type WhitefaceCommand =
  Exclude<ControlCommand, 'status' | 'stop' | 'say' | 'rotate'>

type ControlRequest =
  | {
      cmd: 'status' | 'list' | 'stop' | 'approve-next' | 'deny-next' | 'approve-all' | 'deny-all'
        | 'outbox' | 'cancel-all' | 'rotate' | 'who'
    }
  | { cmd: 'mode'; mode: string }
  | { cmd: 'say'; text: string }
  | { cmd: 'kick'; who: string }
  // "default" puts a bozo back on the room default rather than pinning them.
  | { cmd: 'trust'; who: string; mode: string }
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
  bozos: RosterEntry[]
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
  kicked?: { id: string; name: string }
  trusted?: { id: string; name: string; mode: Mode | null }
  bozos?: RosterEntry[]
  // Everything a fresh link is made of, so the terminal that asked for the
  // rotation can print the new one without reading a file that may not have
  // been rewritten yet.
  meta?: SessionMeta
  stopping?: boolean
}

type ControlReply = StatusReply | ActionReply | { ok: false; error: string }

/* ── ringmaster to bozo ─────────────────────────────────────────────────── */

// Every policy event is rebroadcast under a policy: prefix so a bozo can tell
// the gate's decisions apart from the session's own traffic. policy:mode is the
// exception to the rebroadcast: trust is per bozo, so it is sent to the one
// bozo it is about and says what THAT bozo may now do, not what the room does.
type PolicyBroadcast =
  | { type: 'policy:mode'; mode: Mode }
  | { type: 'policy:sent'; text: string; bozo?: string }
  | { type: 'policy:key'; key: string; bozo?: string }
  | ({ type: 'policy:queued' | 'policy:approved' | 'policy:denied' } & PendingEntry)

type ServerMessage =
  // The greeting also settles the role, and the holder gets the queue with it:
  // a whiteface reconnecting after messages piled up sees them straight away.
  | {
      // mode is this bozo's own effective mode. It is the room default at the
      // moment of a hoink, because trust is per connection and a fresh one
      // carries none, but nothing downstream should assume the two are equal.
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
  // nonce is the sender's own tag for the line, echoed so its browser can
  // settle the copy it drew before the round trip. Everyone gets it and
  // everyone but the sender ignores it: one broadcast beats one frame each.
  | { type: 'f2f'; msg: F2fMessage; nonce?: string }
  // Who is in the circus, whole every time, with the room default alongside:
  // it is thirty short rows at the very most, and a roster that disagrees with
  // the one the host is looking at is worse than the bytes are worth.
  | { type: 'roster'; mode: Mode; bozos: RosterEntry[] }
  // Somebody is typing in the lane. Deliberately not on the roster: it changes
  // every few seconds and expires on its own, so the receiver times it out.
  | { type: 'typing'; bozo: string; name: string }
  // A snapshot of the pane with its scrollback, asked for and answered once.
  // Never the live surface: the mirror positions the cursor relative to a fixed
  // grid, so anything that scrolls has to be somewhere else entirely.
  | { type: 'scrollback'; data: string; cols: number; rows: number; lines: number }
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
  | { type: 'f2f'; text: string; nonce?: string }
  // Presence and typing, both of them cheap and both of them throttled by the
  // sender. here is the heartbeat that says whether anyone is actually looking.
  | { type: 'here'; idle?: boolean }
  | { type: 'typing' }
  | { type: 'scrollback'; lines?: number }
  // The whiteface half of the vocabulary, shaped like a control request minus
  // the cmd key, which the ringmaster fills in from the type.
  | { type: 'list' | 'approve-next' | 'deny-next' | 'approve-all' | 'deny-all' }
  | { type: 'outbox' | 'cancel-all' | 'who' }
  | { type: 'mode'; mode: Mode | 'toggle' }
  | { type: 'trust'; who: string; mode: string }
  | { type: 'kick'; who: string }
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
