# Zavatta: an agent as a bozo

A human bozo is anonymous; the one that is a program gets a proper clown's name.
`src/zavatta.ts` is an MCP server on stdio that joins a session over the ordinary
bozo protocol. The ringmaster neither knows nor cares that this bozo is a
program, so the gate applies unchanged: in the gallery its messages queue for the
host and it cannot press a key.

```jsonc
{ "mcpServers": { "c2c": { "command": "node", "args": ["/path/to/c2c-conv/dist/src/cli.js", "mcp"] } } }
```

Without `--url` it reads the local session's `ringmaster.json` and connects to
loopback; `--url wss://.../bozo?room=...&t=...` points it at a remote session.
`--name` sets its bozo name (default `zavatta`).

## The nine tools

| tool | |
|---|---|
| `c2c_screen` | the session right now, as plain text: only what fits on screen |
| `c2c_scrollback` | the screen plus what scrolled off it, as plain text (`lines`, default 500, capped at tmux's 10000) |
| `c2c_history` | the conversation, including turns from before it joined: numbered, a page of `limit` (default 20), `before` pages back |
| `c2c_status` | mode, pane state, its own messages still held or in the outbox, and who else is in the circus |
| `c2c_send` | text for the session, through the gate |
| `c2c_press` | one allowlisted key |
| `c2c_wait` | block until something worth coming back for happens |
| `c2c_say` / `c2c_f2f` | speak in / read the [f2f lane](f2f-lane.md) |

**No approve, deny, mode, trust or whiteface tool.** An agent that could release
its own messages would collapse the gate
([../decisions.md](../decisions.md#0010-zavatta-has-no-host-tools)).

## Different from the browser

- It drops the pane byte stream (noise without a terminal emulator) and takes
  the screen from snapshots, which is why the ringmaster answers `refresh`.
- It strips ANSI before handing anything over, the scrollback included.
- **It says how much there is.** A history page opens with `turns 481-500 of
  500` and where the older ones start; agents given a bare last-20 did not know
  there was more. Numbers count from the oldest turn the ringmaster still holds
  (`MAX_HISTORY`), so they shift once it starts dropping turns.
- **It waits rather than polls.** `c2c_wait` sits on the socket it already has
  and returns when the condition named in `for` happens: `idle` (the default),
  `dialog`, `reply` (claude answered), `lane` (someone spoke in f2f), or
  `anything` (the first of those, at once if the session is already free or
  asking). *Idle* is not just the pane at a
  prompt: a message of its own still held by the host or still in the outbox
  means the turn it is waiting on has not been asked yet. The pending half is
  tracked per agent from what it was told about itself, since `policy:queued`
  goes to the whiteface alone. Default 60s, capped at 300s because an MCP client
  cuts a tool call that never returns; running out reports that nothing happened
  rather than erroring.

## Sources

- `src/zavatta.ts` (`BozoLink`, `TOOLS`, `historyPage`, `HISTORY_PAGE`, `SCROLLBACK_LINES`, `WAIT_FOR`, `WAIT_MS`, `MAX_WAIT_MS`, `ANSI`)
- `src/cli.ts` (`cmdZavatta`)
- `test/zavatta.test.ts`
