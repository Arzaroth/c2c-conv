# Scrollback

The mirror is the pane, and the pane is what fits on screen. Everything above it
(tool output, diffs, the error you scrolled past) is in the **scrollback** tab: a
snapshot of the pane plus its history, which you can scroll, page and refresh.

## A snapshot, not a surface

The mirror renders a byte stream that positions its cursor relative to a fixed
grid, which is why the live xterm has `scrollback: 0`: scrolling it would put
every later redraw a row off. So the scrollback view is a second xterm, fed
`capture-pane -p -e -S -<n>` on request (`scrollback` message) and nothing else.
It goes stale the moment it arrives, which is honest; `refresh` takes another.
The ringmaster answers with `DEFAULT_SCROLLBACK` (5000) lines when the request
names none.

Zavatta asks with the same message and gets it as plain text from
`c2c_scrollback` ([zavatta.md](zavatta.md)).

## How far back

tmux keeps `HISTORY_LIMIT` (10000) lines per pane. `history-limit` is set on the
c2c server before the session is created, because a pane takes its limit at
creation and ignores the option afterwards; any later and the ceiling would
silently be tmux's 2000 ([../architecture/tmux.md](../architecture/tmux.md#the-session)).

## Sources

- `src/tmux.ts` (`captureScrollback`, `HISTORY_LIMIT`, `newSession`)
- `src/ringmaster.ts` (`#sendScrollback`, `DEFAULT_SCROLLBACK`)
- `web/client.ts` (scrollback panel, the mirror's `scrollback: 0`)
