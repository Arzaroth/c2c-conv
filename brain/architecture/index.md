# Architecture index

The how. Start with [overview.md](overview.md).

| Doc | What's here |
|---|---|
| [overview.md](overview.md) | Processes, components, the state dir, data flow both ways. |
| [tmux.md](tmux.md) | The isolated tmux server, the pane stream and its rotation, host bindings, the status line, `run-shell`, timeouts. |
| [screen.md](screen.md) | Pane states, `classifyScreen`, `readPromptBox`, ghost suggestions, the injection guard, the draft guard, the settle step. |
| [gate.md](gate.md) | `Policy` (room default, trust, text and key gates) and `Outbox` (one writer, hold reasons, `drain` / `through`). |
| [protocol.md](protocol.md) | The RFC 6455 implementation, `ServerMessage` / `BozoMessage`, the control dispatcher, every limit. |
| [transports.md](transports.md) | `LocalTransport`, `--bind`, `--tunnel`, `BigtopTransport` and the bigtop server, the uplink envelope, room rules. |
| [security.md](security.md) | Tokens and the state dir, what gallery and yolo can do, whiteface secrecy, rotate and kick. |
| [testing.md](testing.md) | Pure-logic unit suites, the real-tmux integration test and how its guards were proven, CI. |
