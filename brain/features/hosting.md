# Hosting a session

```sh
c2c host [-s NAME] [-p PORT] [--bind ADDR] [--tunnel] [--bigtop URL] [--room NAME]
         [--token SECRET] [--mode gallery|yolo] [--yolo] [--outbox drain|through]
         [--no-attach] [--cwd DIR] [-- claude args...]
```

- Starts `claude` in a fresh session on the c2c tmux server, in the current
  directory or `--cwd`, spawns the [ringmaster](../architecture/overview.md),
  prints the invite and attaches. `--no-attach` leaves it headless and mints a
  [whiteface](whiteface.md) link.
- Everything after `--` goes to `claude`, shell-quoted so arguments with spaces
  survive: `c2c host -- --model opus --permission-mode plan`.
- Defaults: session `c2c`, port 7331, bind `127.0.0.1`, mode gallery, outbox
  `drain`. `--yolo` is `--mode yolo`.
- Refuses early, before any tmux session exists: a session of that name already
  running, a `--token` under 8 chars, an unknown `--mode` or `--outbox`, a port
  already in use.
- Which transport is chosen by the flags: see
  [../architecture/transports.md](../architecture/transports.md).

Other commands:

| | |
|---|---|
| `c2c attach [-s NAME]` | reattach your terminal |
| `c2c invite [-s NAME]` | reprint the bozo instructions: the ssh forward, LAN and tailscale addresses, the tunnel or bigtop link |
| `c2c say <text>` | a line in the [f2f lane](f2f-lane.md) |
| `c2c ctl ...` | host control, see [../architecture/protocol.md](../architecture/protocol.md#the-control-dispatcher) |
| `c2c restart [-s NAME]` | a new ringmaster for the running session, same links and tunnel, see [restart.md](restart.md) |
| `c2c stop [-s NAME]` | tear it down, including a cloudflared a crashed ringmaster left behind |
| `c2c bigtop [-p PORT] [--bind ADDR]` | run a bigtop (alias `broker`) |
| `c2c zavatta` / `c2c mcp` | the MCP bozo, see [zavatta.md](zavatta.md) |
| `c2c --version` | package version and git revision, `-dirty` if the checkout has changes |

Several sessions can run side by side with distinct `-s` names and ports; the
host bindings resolve `#{session_name}` at keypress time, so each releases into
its own session.

## Sources

- `src/cli.ts` (`parseArgs`, `cmdHost`, `printInvite`, `cmdInvite`, `cmdStop`, `usage`)
- `src/version.ts`, `src/tmux.ts` (`newSession`, `configureHost`)
