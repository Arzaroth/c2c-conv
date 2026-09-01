# Transports

A transport does two things for the relay: carry pane bytes out to guests, and
carry submissions back in. Everything else - the mode ladder, the approval queue,
the injection guard - sits above it and does not care which rung a guest arrived
on. Transports can run at the same time, and a guest on one is indistinguishable
from a guest on another apart from the `via` column in `c2c ctl status`.

```
  relay
    +-- LocalTransport   http + ws on a bound address        (always on)
    +-- BrokerTransport  outbound ws uplink to a rendezvous  (--broker)
```

## Rung 1: loopback plus ssh

The default. The relay binds `127.0.0.1`, so nothing is reachable from outside
the machine until the guest forwards a port:

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

## Rung 3: rendezvous broker

For when neither side can reach the other: both dial *out* to a broker.

```sh
node broker/server.js --port 8080          # somewhere both sides can reach
c2c host --broker wss://broker.example.com --room standup
```

The guest opens `https://broker.example.com/r/standup?t=<token>` and gets the
same client as the local rung, because the broker serves `web/` too. Nothing is
installed on the guest side and nothing is forwarded on yours.

### Why not WebRTC

A data channel still needs a signalling server, and it still needs a TURN relay
whenever both peers are behind symmetric NAT. That is the broker plus more moving
parts, for a latency win that does not matter when the payload is terminal bytes.
If peer-to-peer ever becomes worth it, it slots in as rung 4 behind the same
interface.

### Wire protocol

One websocket carries every guest in a room, so guest-addressed traffic is
enveloped and broadcasts are sent once rather than once per guest.

Host connects to `/uplink?room=R&t=T`:

| direction | frame | meaning |
|---|---|---|
| host to broker | binary | pane bytes, fanned out to every guest |
| host to broker | `{"to":"*","payload":{...}}` | JSON to every guest |
| host to broker | `{"to":"<gid>","payload":{...}}` | JSON to one guest |
| host to broker | `{"to":"<gid>","bin":"<base64>"}` | binary to one guest |
| host to broker | `{"to":"<gid>","evict":true}` | drop that guest |
| broker to host | `{"from":"<gid>","event":"join"}` | a guest arrived |
| broker to host | `{"from":"<gid>","event":"leave"}` | a guest left |
| broker to host | `{"from":"<gid>","event":"message","payload":{...}}` | guest said something |

Guests connect to `/guest?room=R&t=T` and speak the relay's own protocol
unchanged: the broker unwraps envelopes in both directions. That is deliberate -
`web/client.js` has no idea whether it is talking to a local relay or a broker,
so there is exactly one client to maintain.

### Room rules

- The first host to present a room name claims it, and the token is fixed at that
  moment. A second host is refused, so a room cannot be stolen or used to probe
  for the secret.
- Guests are refused if the room has no live host, if the token does not match
  (compared in constant time), or if the room already holds 16 guests.
- When the host disconnects, guests are told `host disconnected` and dropped, and
  the room is deleted. The host's uplink reconnects on its own with exponential
  backoff from 500ms to 15s, reclaiming the room name when it returns.
- Every connection is pinged every 15s and dropped if it misses a pong. This is
  not optional politeness: without it a half-open host connection keeps a room
  name claimed forever, the socket never errors, and every later host is refused
  with a 401 because the room kept the dead host's token. Found in exactly that
  state during testing.

Because a fresh `c2c host` mints a new token by default, the guest link changes
on every restart. Pass `--token` to keep a room's link stable:

```sh
c2c host --broker wss://broker.example.com --room standup --token <secret>
```

### Limits

A broker is meant to sit on a public host, so nothing it accepts is unbounded:

| | |
|---|---|
| rooms | 64 |
| guests per room | 16 |
| room name | 64 chars, `[\w.-]` only |
| token | 8 to 256 chars |

Claiming a room costs a stranger nothing, so the room count is capped; without
that, room creation is somebody else's memory to grow. The token minimum is
enforced here because the broker is the one place that can insist the host
picked a real secret - `c2c host` refuses a short `--token` for the same reason.

Static files resolve against the web root and are rejected unless the resolved
path is still inside it. Stripping `../` prefixes is guesswork; containment is
the only version that is provable.

### Deploying

Zero dependencies, so it is a single file plus `src/ws.js` and `web/`:

```sh
node broker/server.js --port 8080 --bind 0.0.0.0
```

`GET /healthz` returns `{"ok":true,"rooms":N}`. Put it behind TLS and use `wss://`
in `--broker`; the guest client picks `wss` automatically when the page is served
over https. The broker sees all pane bytes in cleartext, so it should be a machine
you control, not a shared one.

A systemd unit and Caddy/nginx configs are in [../deploy](../deploy), along with
the two things a proxy has to get right for websockets and a note on which parts
of this have actually been tested.

When the uplink cannot connect, a failed websocket in node reports a bare
`TypeError` with no reason at all, so the relay probes `/healthz` once per outage
and logs what it finds - `ECONNREFUSED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
`ENOTFOUND` - rather than leaving a bare close code.
