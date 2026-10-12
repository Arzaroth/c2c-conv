# Transports

A transport does two things for the ringmaster: carry pane bytes out to bozos,
and carry their messages back in. Everything else (the gate, the outbox, the
injection guard) sits above it. Transports run side by side, and a bozo on one is
indistinguishable from a bozo on another apart from the roster's `via` column.

```
  ringmaster
    +-- LocalTransport   http + ws on a bound address        (always on)
    +-- BigtopTransport  outbound ws uplink to a rendezvous  (--bigtop)
```

Both implement `Transport` (`types/protocol.d.ts`): `start`, `stop`,
`broadcastBinary`, `broadcastJson`, and `bozo` events carrying a `Channel`.

## Loopback plus ssh

The default. `LocalTransport` binds `127.0.0.1:7331`, serves `dist/web` over
http with `no-cache` (a bozo holding a cached client against an updated
ringmaster looks like a broken feature), and accepts a websocket upgrade whose
`t=` matches the token in constant time. Past `MAX_BOZOS` it answers 429.
Nothing is reachable until the bozo forwards a port:
`ssh -N -L 7331:127.0.0.1:7331 you@your-machine`. `c2c host` and `c2c invite`
print that command with the hostname filled in.

Static paths are normalized and stripped of leading `../`. The bigtop does
containment instead (`resolvePublic`); unifying the two is open in `TODO.md`.

## Bind wider

`--bind 0.0.0.0` (LAN) or a tailnet address. `c2c invite` detects a tailscale
address (`tailscale ip -4`) and offers it. Binding off loopback prints a warning:
from then on the URL token is the only thing between the network and the
session.

## A cloudflared tunnel

`--tunnel` runs `cloudflared` as a child of the ringmaster (`src/tunnel.ts`),
which dials out and hands back a public `trycloudflare.com` URL. The ringmaster
still binds loopback. The tunnel dies with the ringmaster. The binary is
resolved from `$C2C_CLOUDFLARED`, then `node_modules/.bin/`, then
`~/.cloudflared/bin/`, then PATH (why no dependency:
[../decisions.md](../decisions.md#0006-a-bigtop-rather-than-webrtc)).

Verified against a real tunnel (cloudflared 2026.8.2): a bozo connected over
`wss://`, its message reached the session, the stream came back, and the tunnel
process died with the session. That also settled that the websocket upgrade
survives a real HTTP-aware reverse proxy, which the earlier TCP-piping TLS test
never exercised.

## The bigtop

For when neither side can reach the other: both dial **out** to a bigtop
(`bigtop/server.ts`, run with `c2c bigtop` or `node dist/bigtop/server.js`).

```sh
c2c host --bigtop wss://bigtop.example.com --room standup [--token <secret>]
```

The bozo opens `https://bigtop.example.com/r/standup?t=<token>`; the bigtop
serves the same `dist/web` client, so nothing is installed on either side. The
room defaults to the session name. A fresh `c2c host` mints a new token, so the
link changes on every restart unless `--token` pins it.

### Uplink protocol

One websocket carries every bozo in a room. The host connects to
`/uplink?room=R&t=T`; bozos connect to `/bozo?room=R&t=T` and speak the
ringmaster's protocol unchanged, the bigtop unwrapping envelopes both ways, so
there is exactly one client.

| direction | frame | meaning |
|---|---|---|
| host -> bigtop | binary | pane bytes, fanned out to every bozo |
| host -> bigtop | `{"to":"*","payload":{...}}` | JSON to every bozo |
| host -> bigtop | `{"to":"<gid>","payload":{...}}` | JSON to one bozo |
| host -> bigtop | `{"to":"<gid>","bin":"<base64>"}` | binary to one bozo |
| host -> bigtop | `{"to":"<gid>","evict":true}` | drop that bozo |
| bigtop -> host | `{"from":"<gid>","event":"join"}` / `"leave"` | a bozo arrived / left |
| bigtop -> host | `{"from":"<gid>","event":"message","payload":{...}}` | a bozo said something |

(`UplinkFrame`, `DownlinkFrame` in `types/protocol.d.ts`.)

### Room rules

- The first host to present a room name claims it and fixes its token; a second
  host is refused, so a room cannot be stolen or used to probe for the secret.
- Bozos are refused when the room has no live host, the token does not match
  (constant time), or the room holds `MAX_BOZOS` (30, imported from
  `src/policy.ts`).
- Host gone: bozos are told `host disconnected` and dropped, and the room is
  deleted. The uplink reconnects with exponential backoff from 500ms to 15s and
  reclaims the name.
- Every connection is pinged every 15s and dropped on a missed pong. Without it a
  half-open host connection kept a room claimed forever with the dead host's
  token, and every later host got a 401. Found in exactly that state.
- When the uplink cannot connect, node reports a bare `TypeError`, so
  `BigtopTransport` probes `/healthz` once per outage and logs what it finds
  (`ECONNREFUSED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `ENOTFOUND`).

### Limits

| | |
|---|---|
| rooms | 64 (claiming one costs a stranger nothing) |
| bozos per room | 30 |
| room name | 64 chars, `[\w.-]` only |
| token | 8 to 256 chars (`c2c host` refuses a short `--token` for the same reason) |

Static files resolve against the web root and are rejected unless the resolved
path is still inside it (`resolvePublic`). The bigtop sees every pane byte in
cleartext: run it on a machine you control, behind TLS. Deployment:
[../operations.md](../operations.md#deploying-a-bigtop).

## Sources

- `src/transport/local.ts`, `src/transport/bigtop.ts`, `bigtop/server.ts`
- `src/tunnel.ts` (`resolveCloudflared`, `parseTunnelUrl`)
- `src/cli.ts` (`printInvite`, `tailscaleAddress`, `reachableAddresses`)
- `types/protocol.d.ts` (`Transport`, `Channel`, `UplinkFrame`, `DownlinkFrame`)
- `test/local.test.ts`, `test/bigtop.test.ts`, `test/tunnel.test.ts`
