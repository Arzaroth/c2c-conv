# Testing

`node:test`, written in TypeScript under `test/` and run compiled:
`pnpm test` builds, then `node --test dist/test/*.test.js`. There is no coverage
floor.

## Pure logic

Most of the suite, because that is what unit tests can reach:

| Suite | Covers |
|---|---|
| `policy.test.ts` | modes, aliases, trust and its precedence, text and key gates, caps |
| `outbox.test.ts` | ordering, retry with reasons, cancel, bump, failure |
| `screen.test.ts` | `classifyScreen`, `readPromptBox`, ghost suggestions |
| `ws.test.ts` | framing, fragments, the frame cap |
| `bigtop.test.ts` | room rules, envelopes, `resolvePublic`, limits |
| `local.test.ts` | the URL the local transport hands out, the token check, token rotation |
| `whiteface.test.ts` | claims, one holder, reclaim, the command set |
| `transcript.test.ts` | `toEntry` and the records it keeps or drops |
| `zavatta.test.ts` | `stripAnsi`, what wakes a wait, wait timeouts and dropped connections |
| `f2f.test.ts`, `tunnel.test.ts`, `version.test.ts`, `root.test.ts` | the rest |

## The real-tmux integration test

Every bug that cost real time lived in the tmux integration, not in pure logic:
text injected into copy mode wedging the queue, bozo text read as a tmux key,
bindings pointing at the wrong session. `test/tmux.integration.test.ts` drives a
real tmux server running a plain shell and pins those failures. Each guard was
checked by reintroducing its bug and confirming the test goes red; one did not,
and was rewritten until it did. The literal-send test only bites when the payload
is exactly a key name like `C-u`, because tmux sends anything else literally
anyway.

It needs `tmux` on PATH. Its `available` guard does not work: `skip` is read when
the test is declared, before the async `before()` hook can clear the flag, so a
machine without tmux fails those tests rather than skipping them. CI installs
tmux explicitly for that reason ([../operations.md](../operations.md#ci)).

## Sources

- `test/*.test.ts`, `package.json` (`test`), `.github/workflows/ci.yml`
