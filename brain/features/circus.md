# The circus

The roster: who is in the tent, what each may do, which way they got in, whether
they hold the whiteface, and whether anyone is actually watching.

- **`c2c ctl who`** prints it; `c2c ctl status` lists the same bozos with their
  ids alongside the links, the pending queue and the outbox.
- **The circus tab** in the browser (`web/circus.ts`) shows it live with a count
  on the tab: a green pip for anyone watching, amber for a tab left alone. The
  whiteface gets per-row buttons: gallery, ring, default, kick. That is how a
  headless host hands out trust and shows someone the door.
- **`c2c_status`** gives an agent the same list ([zavatta.md](zavatta.md)).

Each row (`RosterEntry`): `id`, `name`, effective `mode`, `trusted` (pinned
personally rather than following the room), `whiteface`, `idle`, `since`, and
`via`, which is a transport (`local`, `bigtop`) rather than an address, so
nothing in it is private from the room.

## When it is sent

The whole roster, with the room default, as one `roster` message on join, leave,
rename, trust, a mode change and a presence flip, and nothing else. Thirty short
rows at most, and a roster that disagrees with the host's is worse than the
bytes.

**Presence.** Connected is not the same as watching, and a lane line typed to
nobody looks like one that was read. A browser sends `here` with `idle: true`
when its tab is hidden or after a minute (`IDLE_MS`) of nobody touching
anything, and only a change is worth a roster: thirty browsers ticking would be
thirty rosters a minute for nothing.

**Typing** is deliberately not on the roster: it changes every few seconds and
expires on its own ([f2f-lane.md](f2f-lane.md)).

## Sources

- `src/ringmaster.ts` (`#roster`, `#sendRoster`, `#findBozos`, `#pickBozo`)
- `web/circus.ts`, `web/client.ts` (`IDLE_MS`, presence)
- `src/cli.ts` (`printWho`, `bozoLine`), `types/protocol.d.ts` (`RosterEntry`)
