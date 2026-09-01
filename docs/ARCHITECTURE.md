# Architecture

```
        host terminal                         guest browser
             |                                      |
        tmux attach                            xterm.js  <--- pane bytes
             |                                      |     ---> submissions
      +------v---------------------+          +-----v------+
      |  tmux server "c2c"         |          |  relay     |
      |    pane: claude            |<--------->  (node)    |
      +----------------------------+ send-keys +-----+-----+
             |                       pipe-pane        |
             |                                        | control.sock
             +--> ~/.claude/projects/.../*.jsonl      |
                  (structured enrichment)        c2c ctl (host)
```

## Components

**tmux session** (`src/tmux.js`)
Owns the `claude` process. Runs on a dedicated tmux server (`-L c2c`) so it never
collides with the host's own tmux. Output leaves via `pipe-pane` into a file;
input enters via `send-keys -l --`, which sends text literally so guest input can
never be interpreted as a tmux key name.

**Relay** (`src/relay.js`)
A detached node process. Tails the pane file, broadcasts raw bytes to guests as
binary websocket frames, and serves the guest client. Holds the policy state and
exposes a unix control socket for the host.

**Policy** (`src/policy.js`)
The mode ladder. `spectator` (default) queues guest submissions for host
approval; `yolo` injects them immediately. Mode lives only in the relay and is
only mutable through the host's control socket, so a guest can never self-promote.

**Websocket** (`src/ws.js`)
RFC 6455 server implemented directly on `node:http` upgrades. Zero dependencies,
so the whole thing runs with nothing installed.

**Guest client** (`web/`)
Read-only xterm.js mirror plus a compose box. The terminal has `disableStdin`, so
the only way a guest reaches the session is through the policy gate.

## Why the pane and not the transcript

The transcript JSONL is cleaner to render but it is undocumented, version-fragile,
and message-granular. The pane bytes are the actual thing the host sees, at
token granularity, including permission prompts and dialogs. The pane is the
source of truth; the transcript is optional enrichment.

## Transport ladder

v0 binds to `127.0.0.1` and expects the guest to arrive over ssh or tailscale:

```
ssh -N -L 7331:127.0.0.1:7331 user@host
```

The relay only needs two operations from any transport: *stream these bytes to
the guest* and *submit this text*. That keeps the later rungs additive rather
than a rewrite:

1. **ssh / tailscale** - today. No hosted infrastructure, no auth to build.
2. **Local web server** - already here, just bind wider and put a real secret in
   front of it.
3. **Hosted rendezvous** - both sides dial out over websocket to a broker. This
   is deliberately preferred over WebRTC: a data channel still needs signalling
   plus a TURN fallback for symmetric NAT, which is most of the cost of running
   the broker anyway. Treat WebRTC as a later latency optimisation, not a v0
   requirement.

## Security model

The token in the URL is the only credential. It is generated per session and
never written to a world-readable place. State lives in `~/.c2c-conv/<session>/`
at mode 0700.

In `spectator` the guest cannot cause any side effect: submissions sit in a queue
until the host releases them.

**The injection guard is part of this, not a nicety.** `send-keys` of text plus
`Enter` into a session that is showing a modal types into nothing and then
confirms whatever option is highlighted. Found the hard way during the first
end-to-end run: an approved guest message arrived while the workspace-trust
dialog was up, and the trailing Enter selected `No, exit` and killed the session.
The same mechanism would let an innocuous-looking guest message confirm a
permission prompt, which would defeat the whole point of spectator mode. So every
write path goes through `tmux.waitForPrompt` first: it waits out a running turn,
but refuses outright on a dialog and tells the host the message was held.

State detection reads an *uncoloured* `capture-pane`. With `-e`, tmux wraps each
individual word in its own SGR pair, so phrase matching silently never matches.

In `yolo` the guest can run arbitrary code as the host. There is no way to offer
"send prompts freely" without this, because a prompt can ask for anything. The
mitigation is social, not technical: only elevate for someone you would hand your
keyboard to.

## Open work

- Input arbitration between host and guest typing simultaneously.
- Scrollback replay for guests joining mid-session (currently seeded with
  `capture-pane`, so only the visible screen).
- Pane file grows for the lifetime of the session; needs rotation.
- Transcript enrichment stream is designed but not yet wired.
