# TODO

What is left, and why each thing is worth doing. Grounded in the code as it
stands at v0.3.5: the architecture is finished for what it does, so almost
nothing here is plumbing.

Done in v0.3.5: the ledger and `c2c log`, a SQLite record of the lane, the gate
and the outbox kept after stop; `c2c restart`, a new ringmaster for a running
session with the links, the tunnel, the lane and both queues kept; zavatta's
`c2c_scrollback` and paged `c2c_history`; a one-line answer no longer hides the
input box. Done in v0.3.4: a dialog hint left in the transcript above the input
box no longer wedges the outbox. Done in v0.3.3: per-bozo trust, so one person can be
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

## History labelled by bozo

**S.** The [ledger](brain/features/ledger.md) knows who sent each delivered
message and when it landed. Label the history panel's user turns with it.

*Risk.* Do not match on the transcript text: `normalize()` in `src/policy.ts`
collapses whitespace before injection, so a turn and its submission differ.
Match on order and time from the `delivered` rows instead.

*Touches:* `src/ringmaster.ts`, `src/transcript.ts`, `web/client.ts`.

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

1. History labelled by bozo
2. `--cols` / `--rows`
3. Replay
