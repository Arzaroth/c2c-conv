# Restart

The tmux session outlives the ringmaster, but the sharing used to live in the
ringmaster's memory: a hotfix or a crash meant `c2c stop`, a new session, new
links for everyone and a new tunnel URL, and the f2f lane and the held queue
were gone. `c2c restart` hands a running session to a fresh ringmaster instead.

```
c2c restart [-s NAME]    (alias: resume)
```

## What survives

| | |
|---|---|
| bozo token, port, bind address | every link handed out keeps working |
| whiteface secret | the whiteface link too, and its holder reclaims the role on reconnect |
| the cloudflared tunnel | same URL, when the old process is still alive ([transports](../architecture/transports.md#a-cloudflared-tunnel)) |
| room default, outbox mode | as the host left them |
| the held queue | ids kept, so `approve 4` still means #4 |
| the outbox | ids kept, delivered from the top |
| the f2f lane | the last 200 lines |
| the history tab | re-read from the transcript JSONL, as on any start ([history.md](history.md)) |
| the scrollback | it lives in tmux, which never stopped ([scrollback.md](scrollback.md)) |

**Not kept: per-bozo trust.** It belongs to a connection, and every connection
drops across a restart, the fail-safe direction
([../decisions.md](../decisions.md#0009-trust-is-per-bozo-keyed-by-connection)).
The restart says so.

Browsers reconnect on their own backoff, and see `c2c is restarting` first.
Zavatta reconnects too, and exits only on a `bye` ([zavatta.md](zavatta.md)).

## How

`snapshot.json` in the state dir (`SessionSnapshot` in `types/protocol.d.ts`) is
rewritten 200ms after any change, so a ringmaster that crashed can be resumed
from where it was, not only one that was asked to go. A real stop removes it,
so a session the host ended never comes back.

1. `c2c restart` sends `handover` over the control socket.
2. The ringmaster stops the outbox, waits out a write already going into the
   pane, writes the snapshot, and stops without killing cloudflared.
3. A ringmaster that does not answer within 5s, or does not exit within 15s, is
   SIGKILLed: SIGTERM is a clean stop, and that removes the snapshot and the
   tunnel. The on-disk snapshot is at most one debounce old. One that answers
   `unknown command` predates restart and is left running: killing it would
   leave nothing to restart from.
4. The CLI starts `__ringmaster` with `C2C_RESUME=1`; it builds itself from the
   snapshot, restores the lane, the queue and the outbox (caps applied again),
   and adopts the cloudflared pid if `ps` still shows it forwarding to that port.

**No message is typed twice.** A message typed into the pane but not yet seen
through by the outbox is left out of the snapshot (`#typed` in
`src/ringmaster.ts`). One that was still waiting for a prompt was never typed,
and goes in from the top.

`handover` is not a whiteface command: like `stop` it ends the ringmaster, and
starting the next one needs the terminal.

## Sources

- `src/cli.ts` (`cmdRestart`, `cmdRingmaster`, `readSnapshot`, `cmdStop`)
- `src/ringmaster.ts` (`handover`, `#snapshot`, `#persist`, `#writeSnapshot`, `#typed`, `stop`)
- `src/tunnel.ts` (`adopt`, `release`, `isTunnelFor`)
- `src/f2f.ts`, `src/policy.ts`, `src/outbox.ts` (`restore`)
- `src/paths.ts` (`snapshotFile`, `tunnelLog`)
- `test/tunnel.test.ts`, `test/outbox.test.ts`, `test/policy.test.ts`, `test/f2f.test.ts`, `test/zavatta.test.ts`
