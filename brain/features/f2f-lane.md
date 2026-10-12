# The f2f lane

*Farce-to-farce.* A chat lane between the clowns. Without it, every word a bozo
typed was a candidate prompt, so "wait, do not run that" either became a message
to claude or went unsaid.

**Nothing in the lane is injected, queued, gated or transcribed.** It has no code
path to the pane at all, and that is the specification
([../decisions.md](../decisions.md#0011-the-f2f-lane-has-no-code-path-to-the-pane)).

- **Browser.** The f2f tab (`web/lane.ts`), with an unread count on the tab.
- **Host.** No browser panel: a bozo's line arrives as a tmux `display-message`
  (with `#` doubled), and the host answers with `c2c say "..."`, which goes over
  the control socket and is marked `host`.
- **Agents.** `c2c_say` and `c2c_f2f` in [zavatta](zavatta.md): an agent that
  cannot hear "wait" is the reason the lane exists.
- **History.** The ringmaster keeps the last 200 lines (`F2F_HISTORY`), each
  capped at 2000 chars; the hoink carries the last 50 (`F2F_GREETING`) so a late
  joiner sees the conversation.

## It knows who is in it

- **Presence.** The lane lists who else is here and whether they are watching,
  from the roster ([circus.md](circus.md)).
- **Typing.** Relayed as its own `typing` message, throttled at both ends and
  timed out by the receiver, never kept as state.
- **Where you got to.** A line marks the last message you saw when you come back
  to the tab.
- **Your own line first.** The browser gives each line it sends a nonce and draws
  it at once; it settles when the ringmaster's broadcast echoes the nonce. One
  that does not come back is marked and offers a resend rather than vanishing.
  The nonce goes out with the broadcast and everyone else ignores it: one frame
  beats one frame each.

## Sources

- `src/f2f.ts` (`Farce`, `MAX_F2F_TEXT`, `F2F_HISTORY`)
- `src/ringmaster.ts` (`#say`, `F2F_GREETING`), `src/cli.ts` (`cmdSay`), `src/tmux.ts` (`notify`)
- `web/lane.ts` (`SETTLE_MS`, `TYPING_MS`, `TYPING_EVERY_MS`, `GROUP_MS`)
