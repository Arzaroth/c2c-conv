# The ledger

claude cannot tell a bozo's message from the host's, which is the point
([../decisions.md](../decisions.md#0001-keystroke-injection-into-a-pty)), so the
transcript cannot say who sent a turn either. The f2f lane and the held queue
used to live in memory only and were gone on stop. The ledger is the record the
ringmaster can keep because it already knows who did what when it happens.

```
c2c log [-s NAME] [--f2f] [--kind K,K] [--grep TEXT] [-n N]
```

It reads `~/.c2c-conv/<session>/ledger.sqlite` directly, so it works with no
ringmaster running and after `c2c stop`. Newest last, 100 rows by default.

## What is recorded

| kind | when | `ref` |
|---|---|---|
| `f2f` | a line in the [lane](f2f-lane.md); `who` is `host` for `c2c say` | |
| `sent` | a yolo bozo's message, straight to the outbox | |
| `held` / `approved` / `denied` | the gallery queue | `#id` |
| `delivered` / `failed` | the [outbox](outbox.md) typed it, or gave up | `oN` |
| `key` | a key pressed from the browser or zavatta | |
| `mode` / `trust` | room default, one bozo's override | |
| `join` / `leave` / `kick` | the [circus](circus.md); `join` carries the origin | |
| `whiteface` | a claim, granted or refused | |
| `rotate` | the link was reset (the token is never written) | |
| `start` | `hosted` or `restarted` ([restart.md](restart.md)) | |

`delivered` is when it actually reached the pane, which can be long after it was
released. Who released or dropped a held message is whoever holds the gate, so
it is not a column.

## Kept, and capped

The file is per session name and outlives stop, so hosting the same name again
appends to it. `MAX_LEDGER_ROWS` (200000) caps it, pruned oldest first every 500
writes: a bozo can write to the lane as fast as it likes. Delete the file to
forget a session.

## Never load-bearing

`node:sqlite` is built into node 22.13 and later, so this is not a dependency
([../decisions.md](../decisions.md#0015-the-ledger-uses-the-sqlite-built-into-node)).
On an older node the ledger is off, with one line in `ringmaster.log`. A write
that fails is logged and dropped: a full disk costs the record, not the session.

## Sources

- `src/ledger.ts` (`Ledger`, `readLedger`, `MAX_LEDGER_ROWS`)
- `src/ringmaster.ts` (`#record`, `#recordPolicy`), `src/cli.ts` (`cmdLog`), `src/paths.ts` (`ledgerFile`)
- `test/ledger.test.ts`
