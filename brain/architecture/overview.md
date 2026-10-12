# Overview

```
        host terminal                         bozo browser
             |                                      |
        tmux attach                            xterm.js  <--- pane bytes
             |                                      |     ---> submissions
      +------v---------------------+          +-----v------+
      |  tmux server "c2c"         |          | ringmaster |
      |    pane: claude            |<-------->|   (node)   |
      +----------------------------+ send-keys+-----+------+
             |                       pipe-pane       |
             |                                       | control.sock
             +--> ~/.claude/projects/.../*.jsonl     |
                  (optional enrichment)          c2c ctl (host)
```

## Processes

- **`c2c host`** (`cmdHost` in `src/cli.ts`) validates flags, creates the tmux
  session running `claude` plus anything after `--` (shell-quoted), installs the
  host bindings, mints the bozo token (16 random bytes, or `--token`, at least 8
  chars) and, when not attaching, a whiteface token. It spawns itself detached as
  `c2c __ringmaster` with the configuration in `C2C_*` environment variables,
  waits for the metadata file, prints the invite and attaches.
- **The ringmaster** (`cmdRingmaster`, `Ringmaster` in `src/ringmaster.ts`)
  lives until the session does: it polls `tmux has-session` every 2s and, when
  the session is gone, tells bozos so before exiting, rather than letting them
  reconnect forever. Its log is `ringmaster.log` in the state dir.
- **`c2c ctl ...`** speaks newline-delimited JSON to the ringmaster's unix
  control socket. The host bindings shell into the same commands.
- **The bigtop** (`bigtop/server.ts`) is a separate process on another machine,
  only for the bigtop rung ([transports.md](transports.md)).
- **Zavatta** (`src/zavatta.ts`) is an MCP server on stdio that connects as a
  bozo ([../features/zavatta.md](../features/zavatta.md)).

## The state dir

`~/.c2c-conv/<session>/`, mode 0700 (`src/paths.ts`):

| File | What |
|---|---|
| `control.sock` | the control socket behind `c2c ctl` |
| `pane.raw` | the `pipe-pane` output the mirror streams from, rotated past 8MB |
| `ringmaster.json` | `SessionMeta`: pid, port, token, links. Unlinked on stop |
| `status.txt` | the tmux status line, rewritten on every state change |
| `ringmaster.log` | the ringmaster's stdout and stderr |

## Components

| Component | File | Job |
|---|---|---|
| tmux wrapper | `src/tmux.ts` | Every tmux call, screen parsing, injection. [tmux.md](tmux.md), [screen.md](screen.md) |
| Pane stream | `src/panestream.ts` | Tails `pane.raw` every 40ms and emits chunks |
| Ringmaster | `src/ringmaster.ts` | Fans pane bytes to transports, runs the gate, the control dispatcher, the roster |
| Policy | `src/policy.ts` | Modes, trust, the text and key gates, the pending queue. [gate.md](gate.md) |
| Outbox | `src/outbox.ts` | The only writer of text to the pane. [gate.md](gate.md) |
| Farce | `src/f2f.ts` | The f2f lane's bounded history. [../features/f2f-lane.md](../features/f2f-lane.md) |
| Whiteface | `src/whiteface.ts` | Claims of the host-in-a-browser role. [../features/whiteface.md](../features/whiteface.md) |
| Transcript | `src/transcript.ts` | Locates and tails the session JSONL. [../features/history.md](../features/history.md) |
| Websocket | `src/ws.ts` | RFC 6455 on `node:http`. [protocol.md](protocol.md) |
| Transports | `src/transport/` | `LocalTransport`, `BigtopTransport`. [transports.md](transports.md) |
| Tunnel | `src/tunnel.ts` | Runs `cloudflared` and parses its URL |
| Bozo client | `web/` | `client.ts` (socket, protocol, mirror, keypad, panels), `circus.ts` (roster tab), `lane.ts` (f2f tab) |

The ringmaster knows nothing about how a bozo arrived: every transport emits
`bozo` events carrying a `Channel` of the same shape, and exposes
`broadcastBinary` so pane bytes cross a bigtop uplink once rather than once per
bozo.

## Data flow

**Out.** claude draws into the pane; `pipe-pane` appends to `pane.raw`;
`PaneStream` tails it; the ringmaster broadcasts each chunk as a binary frame to
every transport; the browser's xterm renders it. A joining bozo gets a `screen`
snapshot (`capture-pane -e` plus the cursor) first, so the stream lands on a
grid that already matches. Every second the ringmaster also polls the pane state
and broadcasts changes, which is how the client knows to show the keypad; the
same poll catches geometry changes (tmux resizes the pane to whatever client
attaches, so a change sends `resize` and a fresh snapshot) and rotates
`pane.raw` past `MAX_PANE_BYTES` (8MB, `C2C_MAX_PANE_BYTES` overrides), sending a
snapshot because the bytes between stop and start are lost.

**In.** A bozo sends `submit`; the `Policy` decides (queue it for approval, or
clear it); a cleared message enters the `Outbox`; the outbox waits for a prompt,
checks for a draft, `send-keys -l -- <text>` then `Enter`, and waits for the box
to settle. Keys take the short path: `Policy.submitKey` then `send-keys` directly.
Details in [gate.md](gate.md) and [screen.md](screen.md).

## Sources

- `src/cli.ts` (`cmdHost`, `cmdRingmaster`, `control`), `src/ringmaster.ts`
- `src/paths.ts`, `src/panestream.ts`, `src/tunnel.ts`
- `types/protocol.d.ts` (`Channel`, `Transport`, `SessionMeta`)
