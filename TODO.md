# TODO

What is left, and why each thing is worth doing. Grounded in the code as it
stands at v0.3.4: the architecture is finished for what it does, so almost
nothing here is plumbing.

Done since v0.3.4: `c2c restart`, a new ringmaster for a running session with
the links, the tunnel, the lane and both queues kept; zavatta's
`c2c_scrollback` and paged `c2c_history`. Done in v0.3.4: a dialog hint left in the transcript above the input box no
longer wedges the outbox. Done in v0.3.3: per-bozo trust, so one person can be
let into the ring without the other twenty-nine coming with them; the circus -
a roster with presence, which is also what `kick` and `trust` needed before
they could be whiteface commands; and CI, which installs tmux and runs the
whole suite on every push.

How the code works is in [brain/BRAIN.md](brain/BRAIN.md). It keeps no
open-work list of its own, so there is one of it rather than two.

## Drift and small fixes

- [ ] `resolvePublic()` lives in `bigtop/server.ts` and is exported, but
      `src/transport/local.ts` still strips `../` prefixes - the approach
      the brain's transports doc calls guesswork next to containment being provable.
      The URL parser makes it hard to reach today, which is not the same as it
      being right. One helper, both transports.
- [ ] `test/tmux.integration.test.ts` fails with `spawn tmux ENOENT` when tmux
      is absent rather than skipping. That is 11 red tests on any machine that
      does not have it, which is every CI runner by default.

- [ ] Mode aliases are listed twice: `ALIASES` in `src/policy.ts` and
      `MODE_ALIASES` in `src/cli.ts`. One list, imported by the CLI.
- [ ] `resolveCloudflared`'s comment in `src/tunnel.ts` says anything on PATH
      wins; the code checks `node_modules/.bin` and `~/.cloudflared/bin` first.
      Decide which is meant and make the other agree.
- [ ] `deploy/README.md` installs and rebuilds with `npm ci`, which fails: the
      repo has a `pnpm-lock.yaml` and no `package-lock.json`.

## Attribution and an audit log

**S.** Write `~/.c2c-conv/<session>/audit.jsonl`: every submission, approval,
denial, key press, mode change, trust change and whiteface claim, with who and
when. Label turns in the history panel with the bozo who sent them.

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

1. Attribution and an audit log - closes the hole the security model opens
2. `--cols` / `--rows`
3. Replay
