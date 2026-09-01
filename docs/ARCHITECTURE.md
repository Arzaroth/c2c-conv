# Architecture

```
        host terminal                         bozo browser
             |                                      |
        tmux attach                            xterm.js  <--- pane bytes
             |                                      |     ---> submissions
      +------v---------------------+          +-----v------+
      |  tmux server "c2c"         |          |  ringmaster     |
      |    pane: claude            |<--------->  (node)    |
      +----------------------------+ send-keys +-----+-----+
             |                       pipe-pane        |
             |                                        | control.sock
             +--> ~/.claude/projects/.../*.jsonl      |
                  (structured enrichment)        c2c ctl (host)
```

## Naming

Component names come from the circus, and each was picked because it explains
the part rather than because it is on theme:

- **bigtop** is the tent everyone gathers in, which is what a rendezvous server
  is. `broker` said "intermediary" but not "meeting place".
- **ringmaster** runs one session: it holds the mode and decides what reaches
  the ring. `relay` undersold it, since it arbitrates rather than forwards.
- **gallery** and **ring** are the two modes. The gallery is the cheap seats:
  watching and heckling, no power. The ring is where the act happens, and a
  bozo there acts as the host. `yolo` shouted the danger, so the docs have to
  keep shouting it now that the name is quieter.

Vocabulary owned by the tools underneath - tmux panes and sessions, websocket
frames, the transcript - is deliberately left alone. Renaming a borrowed term
makes it harder to map the code onto the thing it drives.

The old spellings survive as aliases (`--broker`, `c2c broker`, `mode
spectator`, `mode yolo`) so anything already written against them keeps working.

## Components

**tmux session** (`src/tmux.js`)
Owns the `claude` process. Runs on a dedicated tmux server (`-L c2c`) so it never
collides with the host's own tmux. Output leaves via `pipe-pane` into a file;
input enters via `send-keys -l --`, which sends text literally so bozo input can
never be interpreted as a tmux key name.

**Ringmaster** (`src/ringmaster.js`)
A detached node process. Tails the pane file, hands raw bytes to every active
transport, holds the policy state, and exposes a unix control socket for the host.
It knows nothing about how a bozo arrived.

**Transports** (`src/transport/`)
`LocalTransport` serves the bozo client over http and accepts websocket
upgrades. `BigtopTransport` dials out to a bigtop and multiplexes
every bozo in the room over that one socket. Both emit `bozo` channels with the
same shape, and both expose `broadcastBinary` so pane bytes cross an uplink once
rather than once per bozo.

**Policy** (`src/policy.js`)
The mode ladder. `gallery` (default) queues bozo submissions for host
approval; `ring` injects them immediately. Mode lives only in the ringmaster and is
only mutable through the host's control socket, so a bozo can never self-promote.

**Websocket** (`src/ws.js`)
RFC 6455 server implemented directly on `node:http` upgrades. Zero dependencies,
so the whole thing runs with nothing installed.

**Bozo client** (`web/`)
Read-only xterm.js mirror plus a compose box and a keypad. The terminal has
`disableStdin`, so the only way a bozo reaches the session is through the policy
gate.

## Two channels, not one

Text and keys are separate capabilities with opposite guards, because they solve
opposite problems:

| | text | keys |
|---|---|---|
| allowed when pane is `prompt` | yes | yes |
| allowed when pane is `dialog` | **no**, held | **yes**, that is the point |
| allowed in gallery | queued for approval | **refused outright** |
| allowed in ring | yes | yes |

Text must never reach a dialog, or a bozo message becomes an answer to a
permission prompt. Keys must reach dialogs, or the bozo is stuck the moment
Claude asks anything. Keys are ring-only rather than a third rung on the ladder:
answering a dialog is a side effect by definition, and queueing individual arrow
presses for host approval would be unusable.

The key allowlist is arrows, Enter, Escape, Tab, Backspace and digits 1-9.
Nothing else is accepted, so a bozo cannot send `C-c` or arbitrary control
sequences. The gate lives in the ringmaster, not the UI: a bozo opening their own
websocket and sending a raw key still gets refused.

The ringmaster polls pane state once a second and broadcasts changes, which is how the
client knows to reveal the keypad. The same poll covers two things bozos would
otherwise never see:

- **Pane geometry.** tmux resizes the pane to whatever client attaches, so the
  grid changes under bozos who would keep rendering the old one. A size change
  broadcasts a `resize` and a fresh snapshot. This matters in normal use, since
  `c2c host` attaches by default.
- **Pane file size.** `pipe-pane` appends for the lifetime of the session, so
  the file is rotated past 8MB. Rotating loses the bytes written between stop
  and start, so bozos get a fresh snapshot rather than a stream with a hole in
  it.

## Why the pane and not the transcript

The transcript JSONL is cleaner to render but it is undocumented, version-fragile,
and message-granular. The pane bytes are the actual thing the host sees, at
token granularity, including permission prompts and dialogs. The pane is the
source of truth; the transcript is optional enrichment.

## The transcript stream

`src/transcript.js` tails the session's JSONL and gives bozos a readable
conversation alongside the mirror. It solves the one thing the mirror cannot: a
bozo joining late sees only the current screen, while the transcript has every
turn from the start.

**Finding the right file.** The project directory holds a transcript per
session, so picking the newest would grab any other session sharing the cwd.
Instead the pane's pid leads to Claude Code's own live-session descriptor at
`~/.claude/sessions/<pid>.json`, which carries the `sessionId` and `cwd` that
name the file. tmux may run the pane command through a shell, so the pane pid's
children are checked too.

**It is never load-bearing.** Locating retries rather than failing, every parse
is wrapped, and if any of it breaks the mirror is unaffected and bozos simply
have no history panel. That is the deal with an undocumented format.

**What is emitted.** User turns and assistant turns, with tool calls reduced to
their names. Tool *results* are dropped: they carry whole files and command
output, and a user-role record holding a `tool_result` is not something a person
said. Bozos see all of it in the mirror anyway, so this is about readability,
not concealment.

## Transport ladder

A transport owes the ringmaster two operations: *stream these bytes to the bozo* and
*submit this text*. Everything above it is transport-agnostic, so the rungs are
additive and can run simultaneously.

1. **loopback + ssh** - the default, nothing to deploy.
2. **bind wider** - `--bind` for LAN or a tailnet address.
2b. **cloudflared tunnel** - `--tunnel`, a public URL with nothing to deploy.
3. **the bigtop** - `--bigtop`, both sides dial out, works through NAT on
   both ends.

Full detail, wire protocol and deployment: [TRANSPORTS.md](TRANSPORTS.md).

## Limits on what a bozo can send

The ringmaster accepts a socket from someone else, over a bigtop possibly from
anywhere with the token, so bozo input is bounded at both layers:

- **Frames are capped at 1MB.** A peer can declare a payload length of up to
  2^53 and then send nothing; without a cap the receive buffer grows until the
  process dies. Oversized declarations, slow dribbling towards one, and
  fragments that only exceed the cap once reassembled all close the connection.
- **Messages are capped at 8000 characters.** Longer than that is not a prompt
  somebody typed.
- **The pending queue is capped at 50.** It is the one thing a bozo can grow
  without the host agreeing to anything, so it cannot be unbounded. Verified
  against a live ringmaster with a declared 4GiB frame: connection closed, resident
  memory unchanged, ringmaster healthy.

## Security model

The token in the URL is the only credential. It is generated per session and
never written to a world-readable place. State lives in `~/.c2c-conv/<session>/`
at mode 0700.

In `gallery` the bozo cannot cause any side effect: submissions sit in a queue
until the host releases them.

**The injection guard is part of this, not a nicety.** `send-keys` of text plus
`Enter` into a session that is showing a modal types into nothing and then
confirms whatever option is highlighted. Found the hard way during the first
end-to-end run: an approved bozo message arrived while the workspace-trust
dialog was up, and the trailing Enter selected `No, exit` and killed the session.
The same mechanism would let an innocuous-looking bozo message confirm a
permission prompt, which would defeat the whole point of gallery mode. So every
write path goes through `tmux.waitForPrompt` first: it waits out a running turn,
but refuses outright on a dialog and tells the host the message was held.

State detection reads an *uncoloured* `capture-pane`. With `-e`, tmux wraps each
individual word in its own SGR pair, so phrase matching silently never matches.

In `ring` the bozo can run arbitrary code as the host. There is no way to offer
"send prompts freely" without this, because a prompt can ask for anything. The
mitigation is social, not technical: only elevate for someone you would hand your
keyboard to.

## Input arbitration

Two writers on one pty interleave. Concretely: the host is mid-typing
`deploy to prod` when an approved bozo message injects, the text splices into
the half-written line, and the trailing Enter submits something neither of them
wrote. Three mechanisms stop that:

**A write queue.** Every text injection is serialised behind the last one. Keys
skip the queue deliberately: they are single atomic keystrokes and should not
wait out a text injection's timeout.

**A draft guard.** Before injecting, the ringmaster reads the input box. Anything in
it is the host's unsent draft, so the message is held and the host is told why.

**A settle step.** `send-keys` returns once tmux has queued the keys, well
before the session renders them. Without waiting for the box to read empty twice
running, the next queued message catches the previous one mid-render and is held
as a phantom draft. This cost two wrong fixes before the cause was clear.

What remains unhandled is the host starting to type in the same instant an
injection lands. That needs a lock the TUI does not offer.

## The tmux server is isolated

The c2c server starts with `-f /dev/null`, so the host's `~/.tmux.conf` is not
loaded. That is deliberate: otherwise the host's prefix, key tables, status line
and plugins decide what c2c's documented keys do. A shared session has to behave
the same on everyone's machine, so **the prefix inside a c2c session is always
`C-b`**, whatever the host uses elsewhere.

## Never let run-shell print

The host bindings shell out with `>/dev/null 2>&1`, and that redirect is load
bearing. tmux opens `run-shell` output in a **view-mode pane**, which takes the
pane away from claude and turns it into a copy-mode buffer. Pressing
`prefix + a` therefore hijacked the session, because `c2c ctl approve-next`
prints its JSON reply.

The failure that followed was worse than a cosmetic one. With the pane in
copy-mode, the injected bozo text was read as copy-mode *keystrokes*: the `t`
in "nothing" hit copy-mode's `t` binding, which opens a `(jump to forward)`
command prompt, and `send-keys` then blocked forever feeding that prompt. One
hung call wedged the write queue for the rest of the session.

Three things now prevent it: the bindings are silent, `paneState` reports
`copy-mode` whenever `pane_in_mode` is set so nothing is ever injected into a
mode, and every tmux call has a 10s timeout so no single hung command can wedge
the queue.

## Host controls

The host drives everything from inside the session: `prefix + a` releases the
next waiting message, `prefix + d` drops it, `prefix + y` toggles the mode. The
bindings live on the dedicated `-L c2c` tmux server, so they cannot collide with
the host's own tmux config, and each one shells back into `c2c ctl`.

This is a security property, not a convenience. Gallery is the default and the
safe mode; if approving required leaving the session to type a command, the
practical outcome is everyone parking in ring. The safe path has to be the easy
one.

The status line reads a file the ringmaster rewrites on every state change, rather
than spawning a node process every couple of seconds the way a `#(c2c ctl ...)`
status command would. tmux only runs `#()` jobs while a client is attached, so
it costs nothing when the host is detached.

## Reading the screen

Pane state and the draft both come from parsing a plain `capture-pane`, and both
subtleties here were found the hard way, so `classifyScreen` and `readPromptBox`
are pure functions with their own tests:

- **The footer is not a reliable signal.** It reads `? for shortcuts` when idle,
  but that disappears the moment the host types a character, so footer-keyed
  detection reports `unknown` for any drafted pane. The input box is identified
  structurally instead: a prompt marker directly under a full-width rule.
- **Submitted turns are echoed with the same marker.** Scanning for a bare
  marker finds the last submitted message and reports it as an unsent draft, so
  every follow-up message looks like it would splice into one.
- **No input box is `null`, not `''`.** The box vanishes briefly during redraws,
  and conflating that with "empty" is what made the settle step necessary.

## Tests

Most of the suite is pure logic - the policy gate, the websocket framing, the
screen parsing, the transcript records, the bigtop protocol - because that is
what unit tests can reach.

But every bug in this project that cost real time lived in the tmux
integration, not in pure logic: text injected into copy mode wedging the write
queue, bozo text being read as a tmux key, bindings pointing at the wrong
session. So `test/tmux.integration.test.js` drives a real tmux server running a
plain shell and pins those specific failures. Each of its guards was checked by
reintroducing the bug and confirming the test goes red - one of them did not,
and was rewritten until it did. tmux falls back to literal text for anything it
does not recognise as a key name, so the literal-send test only bites when the
payload is exactly a key name like `C-u`.

## The whiteface

A detached session has nobody at the prefix keys, which used to mean the gallery
was unusable headless: messages could queue but nothing could release them. The
whiteface fixes that without moving host control onto the share link.

- The role is claimed with a token **separate** from the bozo token, so handing
  someone the session does not hand them control of it.
- One holder at a time. The token stays valid rather than being consumed, so a
  dropped connection can reclaim the role, but nobody can take it from whoever
  holds it, and it is released when they disconnect.
- The role is claimed in the HOINK greeting, and the reply carries it along
  with the queue as it stands, so a whiteface that reconnects sees what piled
  up while it was away.
- Its commands are the `c2c ctl` ones, run through the same dispatcher, and the
  gate is in the ringmaster rather than the UI. A bozo that opens its own socket
  and asks to approve is refused exactly the same.
- The pending queue is sent to the whiteface alone. Another bozo's unreleased
  message is not the rest of the gallery's business, least of all one that is
  about to be dropped.

Zavatta deliberately cannot claim it: the MCP server implements no whiteface
tool, so an agent still cannot release its own messages.

## An agent as a bozo

Zavatta is the MCP server: a human bozo is anonymous, and the one that is a
program gets a proper clown's name.

`src/mcp.js` is an MCP server that joins a session over the ordinary bozo
protocol. The ringmaster does not know or care that this bozo is a program, so
the gate applies unchanged.

Two things it does differently from the browser client. It drops the pane byte
stream entirely, because without a terminal emulator those bytes are noise, and
takes the screen from snapshots instead - which is why the ringmaster answers a
`refresh` request. And it strips ANSI before handing anything over, since escape
sequences are for a terminal, not a reader.

**It exposes no approve, deny or mode tool.** That is the whole design: an agent
that could release its own messages would collapse the gate the rest of the
project is built on. Host control stays on the tmux keys and the unix control
socket, both reachable only from the machine itself.

## Open work

- Pane geometry is fixed at 200x50 until a client attaches; no flag for it yet.
- The mirror itself still has no scrollback; history lives in the transcript
  panel instead, which covers conversation but not raw terminal output.
