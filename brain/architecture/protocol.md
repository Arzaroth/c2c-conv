# Protocol

## The websocket

`src/ws.ts` is an RFC 6455 server and client framing on `node:http` upgrades:
no runtime dependency ([../decisions.md](../decisions.md#0007-no-runtime-dependencies)).
`handshake(req, socket)` answers the upgrade and returns a `WebSocket`, which is
also a `Channel` (`sendJson`, `sendBinary`, `close`, `text` and `close`
events). Ping and pong are implemented; the bigtop uses them as a heartbeat.

Frames are capped at `MAX_MESSAGE` (1MB). A peer can declare a payload length up
to 2^53 and send nothing, so without a cap the receive buffer grows until the
process dies. An oversized declaration, slow dribbling towards one, and
fragments that only exceed the cap once reassembled all close the connection.
Verified against a live ringmaster with a declared 4GiB frame: connection
closed, resident memory unchanged.

## Messages

Every wire type is declared once in `types/protocol.d.ts`, ambient, shared by
the Node build and the browser build. Pane bytes travel as binary frames;
everything else is one JSON object per text frame with a `type`.

**Bozo to ringmaster** (`BozoMessage`). Parsed from an untrusted socket, so
every field is checked again at runtime.

| type | |
|---|---|
| `hoink` | the greeting: `name`, and `whiteface` (the token) to claim the role |
| `name` | rename |
| `submit` | text for the session, through the [gate](gate.md) |
| `key` | one allowlisted key, through the gate |
| `refresh` | ask for a fresh `screen` snapshot |
| `scrollback` | ask for a pane-plus-history snapshot of `lines` |
| `f2f` | a lane line, with an optional `nonce` |
| `here` | presence heartbeat, `idle` true or false |
| `typing` | typing in the lane |
| `list`, `mode`, `approve`, `deny`, `approve-next`, ... `trust`, `kick` | whiteface commands, shaped like a control request without `cmd` |

**Ringmaster to bozo** (`ServerMessage`).

| type | |
|---|---|
| `hoink` | the reply: this bozo's own mode, pane state, size, id, name, whether it holds the whiteface, the outbox, the f2f history, and the pending queue for the whiteface alone |
| `named` | the name the ringmaster accepted after a rename |
| `screen`, `resize`, `state` | snapshot with cursor, geometry change, pane state change |
| `accepted`, `pending`, `rejected`, `key:refused` | what happened to this bozo's submission or key |
| `policy:queued` / `approved` / `denied` / `sent` / `key` | gate events. `policy:queued` goes to the whiteface alone |
| `policy:mode` | what THIS bozo may now do, sent to the bozo it is about |
| `policy:held` | why a message is not going in |
| `outbox` | the whole outbox, every change |
| `roster` | the whole roster plus the room default, every change |
| `f2f`, `typing` | a lane line (nonce echoed), someone typing |
| `transcript`, `transcript:history` | [history](../features/history.md) entries |
| `scrollback` | the requested snapshot |
| `control` | a whiteface command's reply, carrying the dispatcher's own reply shape |
| `whiteface:refused`, `notice`, `bye` | role refused, informational line, you are being disconnected and why |

Whole-list messages (`outbox`, `roster`) are sent whole every time: at most
fifty or thirty short rows, and a list that disagrees with the host's is worse
than the bytes.

## The control dispatcher

One vocabulary (`ControlCommand`), two ways in: the unix socket behind
`c2c ctl` (one JSON request, one JSON reply, newline-terminated) and a whiteface
over its bozo socket. `WHITEFACE_COMMANDS` in `src/whiteface.ts` is the subset a
browser may run: everything except `status` (it carries the token), `stop` and
`handover` (ending the session or its ringmaster is the host's alone), `rotate` (its reply is the only place
the new link exists) and `say` (a browser already has the lane).

`c2c ctl` subcommands: `status`, `list`, `who`, `mode <m|toggle>`,
`approve|deny <id>`, `approve-next`, `deny-next`, `approve-all`, `deny-all`,
`outbox`, `cancel <id>`, `cancel-all`, `bump <id>`, `say <text>`,
`trust <who> <mode|default>`, `kick <who>`, `rotate`. A `<who>` is an id or a
name; a name matching more than one bozo is refused rather than guessed.

## Limits

| | | Where |
|---|---|---|
| frame | 1MB | `MAX_MESSAGE`, `src/ws.ts` |
| submitted text | 8000 chars | `MAX_TEXT`, `src/policy.ts` |
| pending queue | 50 | `MAX_PENDING`, `src/policy.ts` |
| outbox | 50 | `MAX_OUTBOX`, `src/outbox.ts` |
| bozos per session and per bigtop room | 30 | `MAX_BOZOS`, `src/policy.ts` (429 past it) |
| f2f line / lines kept | 2000 chars / 200 | `MAX_F2F_TEXT`, `F2F_HISTORY`, `src/f2f.ts` |
| bigtop rooms | 64 | `MAX_ROOMS`, `bigtop/server.ts` |

The pending queue and the outbox are the two things a bozo can grow without the
host agreeing to anything, so neither is unbounded. A restart restores all three
through the same caps rather than trusting the snapshot
([../features/restart.md](../features/restart.md)). The f2f caps are about
memory: the lane reaches nothing but other browsers.

## Sources

- `types/protocol.d.ts`
- `src/ws.ts`, `src/whiteface.ts`, `src/f2f.ts`, `src/policy.ts`, `src/outbox.ts`
- `src/ringmaster.ts` (`#onGuestMessage`, `#hoink`, `#dispatchControl`, `#startControl`)
- `src/cli.ts` (`buildControlMessage`, `CTL_USAGE`)
- `test/ws.test.ts`
