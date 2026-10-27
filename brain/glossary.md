# Glossary

Component names come from the circus, and each was picked because it explains
the part rather than because it is on theme
([decisions.md](decisions.md#0012-circus-names-that-explain-the-part)).
Vocabulary owned by the tools underneath is deliberately left alone.

## The circus

- **bigtop** - the rendezvous server both sides dial out to, when neither can
  reach the other. [architecture/transports.md](architecture/transports.md#the-bigtop).
  Avoid: broker, relay server (`--broker` and `c2c broker` survive as aliases).
- **ringmaster** - the detached node process running one shared session: it
  tails the pane, holds the gate, serves the transports and the control socket.
  [architecture/overview.md](architecture/overview.md). Avoid: relay, server, daemon.
- **bozo** - anyone connected to a session who is not the host at the terminal:
  a browser, or an agent through zavatta. Avoid: guest, viewer, client (the
  code's `#onGuest` predates the name).
- **the circus** - the roster: who is in the tent, what each may do, which way
  they got in, whether anyone is watching. [features/circus.md](features/circus.md).
  Avoid: room, participants.
- **the gallery** - the default mode. Bozo text queues for host approval; keys
  are refused. [features/modes-and-trust.md](features/modes-and-trust.md).
  Avoid: spectator (an alias), read-only.
- **yolo** - the other mode. A bozo's text goes straight to the outbox and keys
  are allowed: they act as the host. Being "in the ring" means being in yolo.
  Avoid: ring as a mode name (an alias only), trusted mode.
- **room default** - the mode a bozo gets when the host has said nothing about
  them in particular. Set by `c2c ctl mode` and `prefix + y`.
- **handover** - one ringmaster giving its running session to the next, by
  `c2c restart`: links, tunnel, lane and queues kept, trust dropped.
  [features/restart.md](features/restart.md). Avoid: reload, resume (an alias).
- **ledger** - `ledger.sqlite`, the per-session record of what happened, read
  with `c2c log`. [features/ledger.md](features/ledger.md). Avoid: audit log,
  history (that is the transcript tab).
- **snapshot** - `snapshot.json`, what a handover or a crash leaves for the next
  ringmaster. Not the scrollback snapshot, which is a capture of the pane.
- **trust** - a per-bozo override of the room default, keyed by connection id.
  `default` clears it. Avoid: role, permission.
- **whiteface** - the clown who runs the ring: the host, from a browser, holding
  a second secret. [features/whiteface.md](features/whiteface.md). Avoid: admin, owner.
- **the outbox** - what is cleared to send and waiting for the pane to be free.
  [features/outbox.md](features/outbox.md). Avoid: queue (that is the pending
  queue, before approval).
- **pending** - a gallery bozo's message waiting for the host to approve or deny
  it. Distinct from the outbox, which comes after approval.
- **f2f** - farce-to-farce: the chat lane between the clowns, which claude never
  hears. [features/f2f-lane.md](features/f2f-lane.md). Avoid: chat, side channel.
- **HOINK** - the greeting. A bozo hoinks its name (and optionally the whiteface
  token), the ringmaster hoinks back with everything the bozo needs to render.
- **zavatta** - the MCP server through which an agent joins as a bozo.
  [features/zavatta.md](features/zavatta.md). Avoid: bot, agent bridge.
- **mirror** - the live xterm in the browser fed the pane's byte stream.

## Borrowed terms (kept as the tools name them)

- **pane**, **session**, **server** - tmux's. The c2c tmux server is `-L c2c`.
  [architecture/tmux.md](architecture/tmux.md).
- **pane state** - `dead`, `copy-mode`, `dialog`, `busy`, `prompt`, `unknown`:
  what the ringmaster reads off a capture. [architecture/screen.md](architecture/screen.md).
- **hold reason** - a pane state, or `draft` / `error`: why the outbox head is
  not moving.
- **draft** - text in claude's input box that the host typed and has not sent.
- **ghost suggestion** - the dim suggested prompt claude paints into an empty
  box. Not a draft. [architecture/screen.md](architecture/screen.md#ghost-suggestions).
- **transcript** - Claude Code's session JSONL under `~/.claude/projects/`.
  [features/history.md](features/history.md).
- **uplink** - the single websocket from a ringmaster to a bigtop.
- **channel** - one bozo's connection as the ringmaster sees it, whichever
  transport carries it (`Channel` in `types/protocol.d.ts`).
- **frame** - a websocket frame. [architecture/protocol.md](architecture/protocol.md).
