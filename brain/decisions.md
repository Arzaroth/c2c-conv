# Decisions

The non-obvious calls, each with its why and what it was chosen over. A decision
with real alternatives gets the next `### NNNN` number; a smaller one is a
bullet under its area.

## The write path

### 0001 Keystroke injection into a PTY

Claude runs inside tmux and bozo text arrives through `tmux send-keys`. A spike
against Claude Code 2.1.251 confirmed the injected prompt lands in the transcript
as `type: user`, `userType: external`, `origin: {kind: "human"}`,
`promptSource: "typed"`, with no cross-session wrapper: byte-identical to the
host typing it, which is the requirement. The same spike drove the
workspace-trust dialog with `Down` + `Enter`, so answering a dialog and
submitting a prompt are one mechanism, which is what makes the gallery/yolo
ladder cheap.

Rejected:

- **The stream-json bridge** (`claude -p --input-format stream-json
  --output-format stream-json ...`). A real bidirectional protocol with genuine
  user turns, but it replaces the interactive TUI: the host would live inside
  our client and we would own permission-prompt rendering. Worth revisiting for a
  native web experience.
- **The local peer bus** (`~/.claude/sessions/<pid>.json`, the
  `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock` socket behind `ListAgents` and
  `SendMessage`). Inbound peer messages are wrapped in
  `<cross-session-message>` and the receiving session is told they are never
  user intent. A bozo message delivered that way arrives explicitly downgraded.

Not to be confused with `claude --remote-control`, which drives a session from
claude.ai or mobile but is single-account, so it does not cover a second person.

### 0002 The pane is the source of truth

The mirror is the `pipe-pane` byte stream, not the transcript. The pane is what
the host actually sees, at token granularity, dialogs included. The transcript
is cleaner to render but undocumented, version-fragile and message-granular
(flushed per message, not per turn), so it is optional enrichment and must never
become load-bearing ([features/history.md](features/history.md)).

### 0003 Text and keys are two channels with opposite guards

Text must never reach a dialog, or a bozo message becomes an answer to a
permission prompt. Keys must reach dialogs, or the bozo is stuck the moment
claude asks anything. So keys are their own capability, yolo-only rather than a
third rung: answering a dialog is a side effect by definition, and queueing
individual arrow presses for approval would be unusable. Keys also skip the
outbox: they are single atomic keystrokes. Table in
[architecture/gate.md](architecture/gate.md#two-channels).

### 0004 A cleared message is never dropped for being busy

The first version injected on approval and gave up after a timeout with a tmux
notice. The bozo was told it went through, the host saw a notice scroll past, and
the words existed nowhere. The outbox inverts it: blocked means *not yet*, with
the reason on the entry for everyone to read. Only a dead pane, a failed write
and a full outbox lose a message, and all three are loud on every surface. The retry announces a reason
once per change of reason, not every 400ms.

### 0005 One writer to the pane

The outbox is the only code that writes text to the pane, so serialisation is
structural rather than a promise chain, and a pane that is not ready blocks the
queue instead of losing its head. What it cannot see is the host typing: the
draft guard and the settle step cover that ([architecture/screen.md](architecture/screen.md)),
and the host starting to type in the very instant an injection lands stays
unhandled, because it needs a lock the TUI does not offer.

## tmux

- **An isolated server with no config** (`-L c2c -f /dev/null`): the host's
  `~/.tmux.conf` would otherwise decide what c2c's documented keys do. The
  prefix inside a c2c session is always `C-b`.
- **Host controls live on prefix keys**, because gallery is the safe mode and a
  safe path that needs another terminal is one nobody takes: everyone would park
  in yolo.
- **The status line reads a file** the ringmaster rewrites on change, rather than
  a `#(c2c ctl ...)` job spawning node every couple of seconds.

## Transports

### 0006 A bigtop rather than WebRTC

A data channel still needs a signalling server, and a TURN server whenever both
peers sit behind symmetric NAT. That is the bigtop plus more moving parts, for a
latency win that does not matter when the payload is terminal bytes.
Peer-to-peer would slot in behind the same `Transport` interface if it ever
became worth it.

- **One client for every transport.** Bozos on a bigtop speak the ringmaster's
  own protocol, unwrapped by the bigtop, so `web/client.ts` cannot tell where it
  is connected.
- **No cloudflared dependency.** The npm `cloudflared` package downloads the same
  Go binary with no checksum or signature check, and the protocol is proprietary
  QUIC, so there is no pure-JS alternative. c2c takes no dependency on it and
  recommends a distribution package, but resolves `$C2C_CLOUDFLARED`, then a
  local npm copy, then `~/.cloudflared/bin`, and only then PATH.
- **The tunnel dies with the ringmaster.** A public URL that outlives the session
  it shared is a hole.

### 0007 No runtime dependencies

The websocket server is RFC 6455 on `node:http` upgrades, and the client bundle
inlines xterm. A built checkout runs with nothing installed and a bozo's browser
loads nothing from a CDN. Chosen over `ws` and a CDN-hosted xterm for supply
chain surface and for a bigtop that deploys with no `node_modules`.

## Trust and control

### 0008 The whiteface holds a separate secret

A detached session had nobody at the prefix keys, so the gallery was unusable
headless. Moving host control onto the share link would hand control to everyone
holding the session; a second token means sharing the session never shares
control of it. One holder at a time, the token is not consumed (a dropped
connection can reclaim), and it rotates with the share link.

### 0009 Trust is per bozo, keyed by connection

With 30 seats, a room-wide switch elevates twenty-nine people to let one in.
Overrides key on the connection id rather than the name, because two bozos can
share a name and a name is theirs to pick. So trust does not survive a reconnect,
which is the fail-safe direction. A pin to `gallery` is worth as much as one to
`yolo`. Not persisted by a future `c2c resume` either, for the same reason.

### 0010 Zavatta has no host tools

The MCP server exposes no approve, deny, mode or whiteface tool. An agent that
could release its own messages would collapse the gate the project is built on.
Host control stays on the tmux keys and the unix socket, reachable only from the
machine.

### 0011 The f2f lane has no code path to the pane

Not a flag on the submission path: a lane whose implementation never calls
`tmux.submit`. A flag can be wrong; a missing path cannot.

- **Rotate stays off the whiteface.** It mints the new secret, its reply is the
  only place the new link exists, and it would cut the socket that asked.
- **Bozos are told and closed before the tokens change**, because rotating the
  bigtop token drops the uplink and a `bye` sent after reaches nobody.

## Naming and versioning

### 0012 Circus names that explain the part

`bigtop` over `broker` (a meeting place, not just an intermediary), `ringmaster`
over `relay` (it arbitrates rather than forwards), `circus` for what anyone else
would call a room. `yolo` kept its name over the on-theme `ring`, because this is
the mode where someone else runs commands as you, and a name that says so is
worth more than a consistent metaphor. Borrowed vocabulary (tmux panes,
websocket frames, the transcript) is left alone so the code maps onto the tools
it drives. Old spellings survive as aliases: mode spellings in `ALIASES`
(`src/policy.ts`) and again in `MODE_ALIASES` (`src/cli.ts`, for `--mode` and
`ctl mode`), `broker` in `src/cli.ts`.

### 0013 Pre-1.0, a minor means a checkout breaks

Written in the CHANGELOG header: a minor bump marks a change that breaks an
existing checkout rather than adding to it. Additions ship as patches, because
the client and the ringmaster ship from the same checkout, so new protocol
messages never meet an old peer. Each release commit says in prose why its bump
is the size it is.

## Restarting

### 0014 A restart hands over rather than starting fresh

A hotfix used to cost everyone their link and the tunnel URL, and cost the room
its f2f lane and held queue, because all of it lived in the ringmaster's
memory. `c2c restart` keeps the tmux session and moves the rest to a new
process through `snapshot.json`, kept current on every change so a crash can be
resumed as well as a handover. Two costs were accepted. cloudflared is detached
rather than a child, because a quick tunnel's URL cannot be asked for twice, so
a ringmaster that dies uncleanly leaves a public URL pointing at a dead port
until `c2c stop`. And the whiteface secret is on disk, at 0600 in the 0700 state
dir next to the token that is already there. Trust stays out: it is per
connection by design (0009), and a restart drops every connection.

### 0015 The ledger uses the SQLite built into node

The lane, the held queue and who sent which turn were lost on stop, and the
transcript cannot attribute a turn by design (0001). The ringmaster records it
as it happens, in SQLite because `c2c log` has to filter by kind and phrase
over a file that grows for as long as a session name is reused. `node:sqlite`
ships with node 22.13 and later, so the no-dependency rule (0007) holds; it is
loaded dynamically and the ledger is simply off on an older node, the same
never-load-bearing stance as the transcript. It sits beside `snapshot.json`
rather than replacing it: the snapshot is the state a restart needs and is
removed on stop; the ledger is history and is kept.

## Sources

- `src/tmux.ts`, `src/policy.ts`, `src/outbox.ts`, `src/ringmaster.ts`
- `src/whiteface.ts`, `src/zavatta.ts`, `src/f2f.ts`, `src/tunnel.ts`, `src/ws.ts`
- `CHANGELOG.md`, release commits (`git log --grep 'chore(release)'`)
