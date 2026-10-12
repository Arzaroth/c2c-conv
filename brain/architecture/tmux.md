# tmux

Every tmux call goes through `src/tmux.ts`. Every bug in this project that cost
real time lived here, which is why the integration test drives a real tmux
server ([testing.md](testing.md)).

## The isolated server

All calls use `SERVER_ARGS`: `-L c2c -f /dev/null`. A dedicated socket so c2c
never collides with the host's own tmux, and no config so the host's
`~/.tmux.conf` (prefix, key tables, status line, plugins) cannot decide what
c2c's documented keys do. **The prefix inside a c2c session is always `C-b`**,
whatever the host uses elsewhere. `attachArgs` repeats the same flags for
`c2c attach`.

Every call has a 10s timeout: `send-keys` blocks indefinitely when the pane sits
at a tmux prompt, and one hung call would wedge the outbox for the rest of the
session.

## The session

`newSession` creates the session detached at 200x50 (`--cols` / `--rows` do not
exist yet, see `TODO.md`), in `--cwd`, running `claude` plus the shell-quoted
passthrough args. Before that it sets the server-global `history-limit` to
`HISTORY_LIMIT` (10000): a pane takes its limit at creation and ignores the
option afterwards, so setting it later would silently leave a 2000-line ceiling
on [scrollback](../features/scrollback.md).

## Writing to the pane

- `sendText` is `send-keys -t <s> -l -- <text>`: `-l` sends literally, so bozo
  input can never be read as a tmux key name, and `--` stops a leading dash being
  parsed as a flag. tmux falls back to literal text for anything that is not a
  key name, which is why the regression test for this uses exactly `C-u`.
- `sendKey` sends one key name, only ever from the policy's allowlist.
- `submit` is `sendText` then `Enter`. Newlines in bozo text would submit
  mid-message, so `normalize()` in `src/policy.ts` collapses whitespace first.
- Nothing calls these without the injection guard first
  ([screen.md](screen.md#the-injection-guard)).

## Reading the pane

- **The stream.** `startPipe` runs `pipe-pane 'cat >> pane.raw'`; `PaneStream`
  tails the file. `pipe-pane` appends for the session's lifetime, so the
  ringmaster rotates the file past 8MB and reseeds every bozo with a snapshot,
  because the bytes written between stop and start are lost.
- **Snapshots.** `capturePane` (`capture-pane -p -e`, with colour) seeds the
  mirror; `captureScrollback` adds `-S -<n>`; `capturePlain` (no `-e`) feeds
  state detection, because with `-e` tmux wraps each word in its own SGR pair and
  phrase matching silently never matches. `cursor` and `paneSize` come from
  `display-message`.
- **Liveness.** `paneAlive`, `panePid` (also used to find the transcript),
  `paneInMode` (`#{pane_in_mode}`).

## Host bindings and the status line

`configureHost` binds `prefix + a` (`approve-next`), `prefix + d`
(`deny-next`) and `prefix + y` (`mode toggle`) on the c2c server, each as
`run-shell -b` into `c2c ctl` with `#{session_name}` resolved when the key is
pressed: key tables are server-global, so a baked-in name would make the last
configured session win.

The status line is `#(cat status.txt)` refreshed every 2s, and the ringmaster
rewrites `status.txt` on every state change (`#writeStatusLine`): mode, bozo
count, how many are in the ring while the room is in the gallery, how many are
waiting for approval, how many are in the outbox. tmux only runs `#()` jobs while
a client is attached, so a detached session costs nothing.

### Never let run-shell print

The bindings redirect to `>/dev/null 2>&1`, and that redirect is load-bearing.
tmux opens `run-shell` output in a view-mode pane, which takes the pane away from
claude. `prefix + a` once did exactly that, because `c2c ctl approve-next`
prints its JSON reply; the next injected bozo text was then read as copy-mode
keystrokes, a `t` opened copy-mode's `(jump to forward)` prompt, and `send-keys`
blocked forever feeding it. Three guards now: silent bindings, `paneState`
reporting `copy-mode` whenever `pane_in_mode` is set so nothing is injected into
a mode, and the 10s timeout on every call.

## Notifications

`notify` is `display-message`, used for f2f lines and outbox hold reasons. It
doubles every `#` first, because `display-message` expands `#{...}` formats and
what it carries is mostly a bozo's name or words.

## Sources

- `src/tmux.ts` (`SERVER_ARGS`, `HISTORY_LIMIT`, `newSession`, `configureHost`,
  `sendText`, `submit`, `notify`, `startPipe`, `capturePlain`)
- `src/panestream.ts`, `src/ringmaster.ts` (`#rotatePaneFile`, `#writeStatusLine`)
- `test/tmux.integration.test.ts`
