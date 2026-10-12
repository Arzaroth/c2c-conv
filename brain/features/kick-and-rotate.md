# Kick and rotate

The link is the whole credential, and a link that has been sent is one you no
longer control. Before these, the only undo was `c2c stop`, which ended the
claude session everyone was working in.

## kick

```sh
c2c ctl kick 01a8c1a0     # by id, or by name
```

Disconnects one bozo with a `bye` saying why. It revokes nothing: they still hold
a working link and can walk back in. It is for "you are in the wrong session".
`c2c ctl status` lists each bozo with its id, because two bozos called `bozo` is
the normal case; a name matching more than one is refused rather than guessed.
Also a whiteface command, from the circus tab.

## rotate

```sh
c2c ctl rotate
```

Puts everybody out, replaces the bozo token **and** the whiteface token, and
prints the new invite. Every URL handed out stops working, the whiteface link
included: rotating only the share link would leave an old `w=` to paste onto the
new `t=`. On a bigtop the room is dropped and reclaimed under the new token. The
claude session is untouched; nobody loses work.

Bozos are told and closed *before* the tokens change, so a browser stops
retrying instead of reconnecting into a 401
([../architecture/security.md](../architecture/security.md#taking-a-link-back)).
Rotate stays off the whiteface: it mints the secret, its reply is the only place
the new link exists, and it would cut the socket that asked.

## Sources

- `src/ringmaster.ts` (`#rotate`, `#pickBozo`, `#dispatchControl`)
- `src/cli.ts` (`printRotated`), `src/transport/bigtop.ts`
