# Security model

## Credentials

- **The bozo token** in the URL (`t=`) is the only credential for watching and
  talking. 16 random bytes per session unless `--token` pins one (minimum 8
  chars). Compared in constant time (`src/secret.ts`) by both transports.
- **The whiteface token** (`w=`) is a second, separate secret, minted only for a
  detached session. Leaking the share link must not hand over control
  ([../features/whiteface.md](../features/whiteface.md)).
- State lives in `~/.c2c-conv/<session>/` at mode 0700; the token is never
  written anywhere world-readable. `ringmaster.json` holds it and is unlinked on
  stop. `snapshot.json` (0600) holds it too, with the whiteface secret, the held
  queue and the f2f lane, so `c2c restart` can bring them back; it is removed
  on stop ([../features/restart.md](../features/restart.md)).
- **A tunnel can outlive its ringmaster** now: a handover leaves it for the
  next one, and a crash leaves it forwarding to a dead port until `c2c stop` or
  `c2c restart`. Nothing answers behind it, but the URL is still public.
- The host's own control path is the unix socket and the tmux prefix keys, both
  reachable only from the machine itself.

## What each mode can do

**Gallery.** A bozo cannot cause a side effect: text sits in the pending queue
until the host releases it, and keys are refused outright. Even released text
cannot answer a dialog ([screen.md](screen.md#the-injection-guard)).

**Yolo.** A bozo can run arbitrary code as the host. There is no way to offer
"send prompts freely" without this, because a prompt can ask for anything. The
mitigation is social: only elevate someone you would hand your keyboard to. The
name is kept loud on purpose
([../decisions.md](../decisions.md#0012-circus-names-that-explain-the-part)).
In the container, yolo means commands as the container user over the mounted
paths ([../features/container.md](../features/container.md)).

**Trust is per bozo and per connection** (`MAX_BOZOS` is 30, so a room-wide
switch would elevate everyone). It does not survive a reconnect, the fail-safe
direction, and the close handler forgets it. A pin to `gallery` holds when the
room default goes to yolo. Only what a bozo may do is per bozo; `policy:mode`
tells each bozo its own mode and the room default rides the roster.

## Gates are in the ringmaster

Every check (mode, key allowlist, whiteface commands) runs in the ringmaster, not
the UI. A bozo opening its own websocket and sending a raw key, an approve, or a
whiteface claim with a wrong token is refused exactly as the browser would be.
Zavatta has no host tools at all
([../decisions.md](../decisions.md#0010-zavatta-has-no-host-tools)).

## Bounded input

A bozo may be anyone holding the token, from anywhere over a bigtop or tunnel,
so every input is capped: frames, text, the pending queue, the outbox, the lane,
the bozo count, bigtop rooms. Table in [protocol.md](protocol.md#limits).

## Taking a link back

- **`c2c ctl kick <who>`** disconnects one bozo without revoking anything.
- **`c2c ctl rotate`** replaces the bozo token **and** the whiteface secret (so
  an old `w=` cannot be pasted onto the new `t=`), puts everyone out, and on a
  bigtop drops and reclaims the room under the new token. Each bozo gets `bye`
  and is closed *before* the tokens change, because rotating the bigtop token
  drops the uplink and a `bye` after that reaches nobody; bozos would then get
  the bigtop's "host disconnected" and reconnect into a 401 forever.

User-facing detail: [../features/kick-and-rotate.md](../features/kick-and-rotate.md).

## Exposure by transport

Loopback needs an ssh forward, so ssh is the authentication. `--bind` off
loopback, `--tunnel` and `--bigtop` all leave the token doing all the work; the
tunnel URL is public and handed out by Cloudflare, and a bigtop sees every pane
byte in cleartext ([transports.md](transports.md)).

## Sources

- `src/secret.ts`, `src/paths.ts`, `src/whiteface.ts`, `src/policy.ts`
- `src/ringmaster.ts` (`#rotate`, `#onGuest`, `#hoink`, `#pickBozo`)
- `src/transport/local.ts`, `bigtop/server.ts`
- `test/whiteface.test.ts`, `test/policy.test.ts`
