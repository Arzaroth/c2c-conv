# Modes and trust

Bozos start in **the gallery**: they see everything, and anything they send waits
for the host. **Yolo** puts a bozo in the ring: their text goes straight to the
[outbox](outbox.md) and they can press keys, which means running commands as the
host ([../architecture/security.md](../architecture/security.md)).

## The host's keys

From inside the session, without leaving it:

| key | |
|---|---|
| `prefix + a` | release the next waiting message |
| `prefix + d` | drop it |
| `prefix + y` | toggle the room default between gallery and yolo |

The prefix is always `C-b` inside a c2c session. Gallery is the safe mode, so the
safe path has to be the easy one: if approving meant another terminal, everyone
would park in yolo. The status bar carries the state the whole time:

```
c2c gallery | 3 bozos | 1 in the ring | 2 waiting (prefix+a approve, prefix+d deny) | 1 in the outbox
```

`in the ring` appears only while the room is in the gallery: in a gallery, the
trusted bozo is the only one who can act.

Each queued message also arrives as a tmux notice. `c2c ctl list` /
`approve <id>` / `deny <id>` / `approve-all` / `deny-all` do the same from a
script or another window.

## Room default and per-bozo trust

`prefix + y` and `c2c ctl mode gallery|yolo|toggle` set the **room default**:
what a bozo gets when the host has said nothing about them. With up to thirty
bozos that is blunt, so trust is also per bozo:

```sh
c2c ctl who                    # who is here and what each may do
c2c ctl trust alice yolo       # alice alone goes into the ring
c2c ctl trust bob gallery      # bob stays out, whatever the room does
c2c ctl trust alice default    # back to the room default
```

- A pin holds against the room default moving, in both directions.
- Trust belongs to the connection, not the name, so it does not survive a
  reconnect: whoever comes back is in the gallery until the host says otherwise.
- `<who>` is an id or a name; a name matching several bozos is refused.
- Each bozo is told its own mode (`policy:mode`); the roster carries the room
  default. The browser's circus tab gives the whiteface the same controls per row
  ([circus.md](circus.md)).
- Old spellings work wherever a mode is named: `spectator`, `ring`.

`--yolo` (or `--mode yolo`) starts the room wide open; then the link is the whole
security boundary.

## Sources

- `src/policy.ts`, `src/tmux.ts` (`configureHost`), `src/ringmaster.ts`
  (`#writeStatusLine`, `#onPolicyEvent`, `#dispatchControl`, `#tellMode`)
- `src/cli.ts` (`buildControlMessage`, `printWho`, `printStatus`)
