# Transports

A transport does two things for the ringmaster: carry pane bytes out to bozos, and
carry submissions back in. Everything else - the mode ladder, the approval queue,
the injection guard - sits above it and does not care which rung a bozo arrived
on. Transports can run at the same time, and a bozo on one is indistinguishable
from a bozo on another apart from the `via` column in `c2c ctl status`.

```
  ringmaster
    +-- LocalTransport   http + ws on a bound address        (always on)
    +-- BigtopTransport  outbound ws uplink to a rendezvous  (--bigtop)
```

## Rung 1: loopback plus ssh

The default. The ringmaster binds `127.0.0.1`, so nothing is reachable from outside
the machine until the bozo forwards a port:

```sh
ssh -N -L 7331:127.0.0.1:7331 you@your-machine
```

`c2c host` and `c2c invite` print the exact command with your hostname filled in.
No deployment, no inbound firewall rule, and the ssh session is the authentication.

## Rung 2: bind wider

```sh
c2c host --bind 0.0.0.0          # LAN
c2c host --bind 100.64.0.39      # a tailnet address
```

`c2c invite` detects a tailscale address and offers it. Binding off loopback
prints a warning, because from that point the URL token is the only thing between
a stranger on the network and your session.

## Rung 3: a cloudflared tunnel

```sh
c2c host --tunnel
```

cloudflared dials out and hands back a public `trycloudflare.com` URL, so this
reaches anyone with no deployment, no inbound rule and no NAT traversal. The
ringmaster still binds loopback; the tunnel is the only thing exposed.

The tunnel is a child of the ringmaster and is killed with it, because a public
URL that outlives the session it was sharing is a hole rather than a
convenience.

The link is public, so the token is doing all the work. That is the same
position as the bigtop rung, but the URL is handed out by Cloudflare rather
than chosen by you.

### Getting cloudflared

It needs the `cloudflared` binary. There is an npm package of the same name with
a pleasant API, but it is a wrapper: its installer downloads the same Go binary
from GitHub releases and chmods it 755, with no checksum and no signature
check - Cloudflare ships no checksum file to verify against either. Cloudflare
Tunnel speaks a proprietary QUIC protocol to their edge, so there is no pure-JS
implementation that would avoid the binary.

c2c therefore takes no dependency on it, and a signed package from your
distribution is the better source. But if you already have the npm one, c2c uses
it: binary resolution checks `$C2C_CLOUDFLARED`, then `node_modules/.bin/`, then
`~/.cloudflared/bin/`, then PATH. No reason to make you install it twice.

**Verified against a real tunnel.** cloudflared 2026.8.2 established a quick
tunnel, a bozo connected over `wss://` to the public URL, its message reached
the session and the pane stream came back. The tunnel process died with the
session, leaving nothing listening.

That also settles the question the nginx and Caddy configs could not: **the
websocket upgrade survives a real HTTP-aware reverse proxy.** Cloudflare's edge
is one, and it rewrites headers like any other. The earlier TLS test only piped
TCP, so it never exercised that.

## Rung 4: the bigtop

For when neither side can reach the other: both dial *out* to a bigtop.

```sh
node bigtop/server.js --port 8080          # somewhere both sides can reach
c2c host --bigtop wss://bigtop.example.com --room standup
```

The bozo opens `https://bigtop.example.com/r/standup?t=<token>` and gets the
same client as the local rung, because the bigtop serves `web/` too. Nothing is
installed on the bozo side and nothing is forwarded on yours.

### Why not WebRTC

A data channel still needs a signalling server, and it still needs a TURN ringmaster
whenever both peers are behind symmetric NAT. That is the bigtop plus more moving
parts, for a latency win that does not matter when the payload is terminal bytes.
If peer-to-peer ever becomes worth it, it slots in as rung 4 behind the same
interface.

### Wire protocol

One websocket carries every bozo in a room, so bozo-addressed traffic is
enveloped and broadcasts are sent once rather than once per bozo.

Host connects to `/uplink?room=R&t=T`:

| direction | frame | meaning |
|---|---|---|
| host to bigtop | binary | pane bytes, fanned out to every bozo |
| host to bigtop | `{"to":"*","payload":{...}}` | JSON to every bozo |
| host to bigtop | `{"to":"<gid>","payload":{...}}` | JSON to one bozo |
| host to bigtop | `{"to":"<gid>","bin":"<base64>"}` | binary to one bozo |
| host to bigtop | `{"to":"<gid>","evict":true}` | drop that bozo |
| bigtop to host | `{"from":"<gid>","event":"join"}` | a bozo arrived |
| bigtop to host | `{"from":"<gid>","event":"leave"}` | a bozo left |
| bigtop to host | `{"from":"<gid>","event":"message","payload":{...}}` | bozo said something |

Bozos connect to `/bozo?room=R&t=T` and speak the ringmaster's own protocol
unchanged: the bigtop unwraps envelopes in both directions. That is deliberate -
`web/client.js` has no idea whether it is talking to a local ringmaster or a bigtop,
so there is exactly one client to maintain.

### Room rules

- The first host to present a room name claims it, and the token is fixed at that
  moment. A second host is refused, so a room cannot be stolen or used to probe
  for the secret.
- Bozos are refused if the room has no live host, if the token does not match
  (compared in constant time), or if the room already holds 16 bozos.
- When the host disconnects, bozos are told `host disconnected` and dropped, and
  the room is deleted. The host's uplink reconnects on its own with exponential
  backoff from 500ms to 15s, reclaiming the room name when it returns.
- Every connection is pinged every 15s and dropped if it misses a pong. This is
  not optional politeness: without it a half-open host connection keeps a room
  name claimed forever, the socket never errors, and every later host is refused
  with a 401 because the room kept the dead host's token. Found in exactly that
  state during testing.

Because a fresh `c2c host` mints a new token by default, the bozo link changes
on every restart. Pass `--token` to keep a room's link stable:

```sh
c2c host --bigtop wss://bigtop.example.com --room standup --token <secret>
```

### Limits

A bigtop is meant to sit on a public host, so nothing it accepts is unbounded:

| | |
|---|---|
| rooms | 64 |
| bozos per room | 16 |
| room name | 64 chars, `[\w.-]` only |
| token | 8 to 256 chars |

Claiming a room costs a stranger nothing, so the room count is capped; without
that, room creation is somebody else's memory to grow. The token minimum is
enforced here because the bigtop is the one place that can insist the host
picked a real secret - `c2c host` refuses a short `--token` for the same reason.

Static files resolve against the web root and are rejected unless the resolved
path is still inside it. Stripping `../` prefixes is guesswork; containment is
the only version that is provable.

### Deploying

Zero dependencies, so it is a single file plus `src/ws.js` and `web/`:

```sh
node bigtop/server.js --port 8080 --bind 0.0.0.0
```

`GET /healthz` returns `{"ok":true,"rooms":N}`. Put it behind TLS and use `wss://`
in `--bigtop`; the bozo client picks `wss` automatically when the page is served
over https. The bigtop sees all pane bytes in cleartext, so it should be a machine
you control, not a shared one.

A systemd unit and Caddy/nginx configs are in [../deploy](../deploy), along with
the two things a proxy has to get right for websockets and a note on which parts
of this have actually been tested.

When the uplink cannot connect, a failed websocket in node reports a bare
`TypeError` with no reason at all, so the ringmaster probes `/healthz` once per outage
and logs what it finds - `ECONNREFUSED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
`ENOTFOUND` - rather than leaving a bare close code.
