# The whiteface

The clown who runs the ring: the host, from a browser. A detached session has
nobody at the prefix keys, which used to make the gallery unusable headless:
messages queued and nothing could release them.

```sh
c2c host --no-attach --tunnel
```

A detached session mints a second link, printed only to the host:

```
https://....trycloudflare.com/?t=<bozo token>&w=<whiteface token>
```

Opening it gives release, drop and the mode switch in the browser, plus the
outbox controls, the roster buttons ([circus.md](circus.md)) and the keypad in
either mode ([keypad.md](keypad.md)). Bozos get the link without `w=`.

## Rules

- **A separate secret** from the bozo token, so sharing the session never
  shares control of it
  ([../decisions.md](../decisions.md#0008-the-whiteface-holds-a-separate-secret)).
- **One holder at a time.** The token is not consumed, so a dropped connection
  can reclaim the role, but nobody can take it from whoever holds it. It is
  released on disconnect.
- **Claimed in the hoink.** The reply carries the role and the pending queue as
  it stands, so a whiteface that reconnects sees what piled up.
- **The pending queue goes to the whiteface alone.** Another bozo's unreleased
  message is not the gallery's business.
- **Commands are the `c2c ctl` ones**, through the same dispatcher, limited to
  `WHITEFACE_COMMANDS` (no `status`, `stop`, `rotate`, `say`; see
  [../architecture/protocol.md](../architecture/protocol.md#the-control-dispatcher)).
  The check is in the ringmaster: a bozo asking to approve is refused
  (`whiteface:refused`).
- **Rotated with the share link** by `c2c ctl rotate`.
- Zavatta cannot claim it: it has no tool for it.

An attached `c2c host` has no whiteface token at all; the host has the keys.

## Sources

- `src/whiteface.ts` (`Whiteface`, `WHITEFACE_COMMANDS`)
- `src/ringmaster.ts` (`#hoink`, `#onGuestMessage`, `#rotate`)
- `src/cli.ts` (`cmdHost`), `web/client.ts`
- `test/whiteface.test.ts`
