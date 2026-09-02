# TODO

What is left, and why each thing is worth doing. Grounded in the code as it
stands at v0.3.2: the architecture is finished for what it does, so almost
nothing here is plumbing.

Done since v0.3.1: `c2c_wait`, so an agent bozo can sit on the socket rather
than poll the screen, and revocation - `c2c ctl kick` for one bozo, `c2c ctl
rotate` to replace the token and kill every link already handed out.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#open-work) used to carry a short
open-work list of its own. It points here now, so there is one of it rather than
two.

## Drift and small fixes

- [ ] `docs/TRANSPORTS.md` says 16 bozos per room, twice. `MAX_BOZOS` in
      `src/policy.ts` is 30, and the bigtop imports it.
- [ ] `resolvePublic()` lives in `bigtop/server.ts` and is exported, but
      `src/transport/local.ts` still strips `../` prefixes - the approach
      TRANSPORTS.md itself calls guesswork next to containment being provable.
      The URL parser makes it hard to reach today, which is not the same as it
      being right. One helper, both transports.
- [ ] `test/tmux.integration.test.ts` fails with `spawn tmux ENOENT` when tmux
      is absent rather than skipping. That is 9 red tests on any machine that
      does not have it, which is every CI runner by default.

## Add CI

**S.** Add a workflow that installs tmux and runs the whole suite, integration
tests included.

*Why.* Nothing runs the integration tests anywhere but a developer's machine
with tmux on it. The Dockerfile is already a working CI substrate: it has node,
tmux and claude in it. (The other half of this item, xterm from a CDN, is done:
vite bundles it into `dist/web`.)

*Touches:* `test/tmux.integration.test.ts`, new `.github/workflows/`,
`Dockerfile`.

## Attribution and an audit log

**S.** Write `~/.c2c-conv/<session>/audit.jsonl`: every submission, approval,
denial, key press, mode change and whiteface claim, with who and when. Label
turns in the history panel with the bozo who sent them.

*Why.* The design guarantees Claude cannot tell a bozo's message from the host's,
which is correct and is the whole point. It also means nobody can afterwards. For
a session that spent any time in yolo, the ringmaster's `console.log` lines are
the only record that anything happened, and `ringmaster.log` is not a record, it
is a debug stream.

*Risk.* Do not try to reconstruct this from the transcript JSONL. `normalize()`
in `src/policy.ts` collapses whitespace before injection, so matching a user turn
back to a submission is fuzzy. Log at the ringmaster, where the attribution is
already in hand.

The outbox is the other half of this: it already knows who sent what and when
it actually landed, which is the attribution the transcript cannot give you.

*Touches:* `src/policy.ts` events, `src/outbox.ts` events, `src/ringmaster.ts`,
`src/transcript.ts`, `web/client.ts`.

## `c2c resume`

**M.** Persist token, mode, whiteface token and the pending queue into the state
dir, and let a fresh ringmaster adopt a tmux session that is still running.

*Why.* The tmux session outlives the ringmaster but the sharing does not. All of
that state is process memory, and `metaFile` is unlinked on stop, so a crash
leaves a live claude session with no way back other than `c2c stop`. The
long-lived sessions are exactly the `--tunnel` and `--bigtop` ones, where losing
the URL costs the most.

*Touches:* `src/ringmaster.ts` (`#writeMeta`, `start`), `src/cli.ts`,
`src/paths.ts`, `src/whiteface.ts`.

## Say who is in the lane

**S.** The f2f lane has no presence: you cannot tell whether the person you are
talking to is still there, and a line typed into an empty room looks the same as
one that was read.

*Why.* The lane exists so a bozo can say "wait, do not run that" before it
matters. Not knowing whether anyone is on the other end is most of the value of
a chat surface, and `#bozos` already holds exactly who is connected.

*Touches:* `src/ringmaster.ts` (`#onGuest`, `#hoink`), `web/client.ts`.

## Per-bozo trust, not one switch

**M.** Elevate one person to the ring without elevating the other twenty-nine.

*Why.* `Policy.#mode` is process-wide, so `prefix + y` promotes the whole room,
and `MAX_BOZOS` is 30. That is fine for a pair session and wrong for anything
with an audience, which is what thirty implies. The queue entries already carry
`bozo` and `#bozos` is a keyed map, so the state has somewhere to live.

*Touches:* `src/policy.ts`, `src/ringmaster.ts` (`#onGuestMessage`),
`c2c ctl mode <bozo>`, `web/client.ts`.

## `--cols` and `--rows`

**S.** Geometry is hardcoded at 200x50 in `tmux.newSession` until a client
attaches, and there is no flag.

Fitting automatically to the smallest connected bozo is the larger version and
needs `window-size manual`, because tmux otherwise resizes to whatever attaches.
Worth doing only once someone complains.

*Touches:* `src/tmux.ts`, `src/cli.ts`.

## Session replay

**L.** `pane.raw` already holds the entire byte stream. Timestamp the frames,
keep the file on stop instead of unlinking it, and `c2c replay` gives an
asciinema-style playback: something to hand to someone who was not there.

*Why.* The mirror is live-only. This is also the largest change in what the
product is, from "share a session" to "share what happened".

*Risk.* `pane.raw` is transient by design, and it holds everything that was ever
on screen, secrets included. Retention has to be opt-in, and rotation at 8MB
currently discards history rather than rolling it.

*Touches:* `src/panestream.ts`, `src/ringmaster.ts` (`#rotatePaneFile`),
`src/cli.ts`, `web/`.

## Order

By value against effort:

1. Add CI - the integration tests run nowhere automatic
2. Attribution and an audit log - closes the hole the security model opens
3. `c2c resume`
4. Per-bozo trust
5. Who is in the lane
6. `--cols` / `--rows`
7. Replay
