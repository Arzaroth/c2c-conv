# Deploying the bigtop

The bigtop is the only piece meant to live on a server. It is a single node
file with no runtime dependencies, it binds loopback, and it holds no state
worth persisting: rooms exist only while a host is connected.

It is compiled from TypeScript, so a checkout has to be built before it will
run - the unit points at `dist/bigtop/server.js`, and the browser client the
bigtop serves is built from `web/client.ts` by the same step.

```sh
useradd --system --home /opt/c2c-conv c2c
git clone <repo> /opt/c2c-conv
cd /opt/c2c-conv && npm ci && npm run build
install -m644 /opt/c2c-conv/deploy/c2c-bigtop.service /etc/systemd/system/
systemctl enable --now c2c-bigtop
```

Rebuild on every update: `git pull && npm ci && npm run build && systemctl restart c2c-bigtop`.

Then put TLS in front of it with [Caddyfile](Caddyfile) or
[nginx.conf](nginx.conf), and point hosts at it:

```sh
c2c host --bigtop wss://bigtop.example.com --room standup --token <secret>
```

## What the proxy has to get right

Two things, and only one of them is obvious.

**Pass the upgrade through.** Caddy's `reverse_proxy` does this on its own.
nginx does **not**: without `proxy_set_header Upgrade` and `Connection`, the
handshake returns 200 instead of 101 and every bozo sits at "offline"
retrying. That looks like a broken bigtop rather than a proxy problem.

**Do not time out idle connections.** A bozo watching without typing sends
nothing for minutes. nginx's default `proxy_read_timeout` is 60s, which would
cut healthy connections repeatedly. The bigtop already pings every 15s and
drops peers that miss a pong, so dead connections are detected without the
proxy's help. Both configs here set the timeouts accordingly.

## Checking it works

`GET /healthz` returns `{"ok":true,"rooms":N}` and is the fastest way to tell
whether the proxy reaches the bigtop at all.

If the uplink will not connect, `c2c ctl status` shows the bigtop line and the
ringmaster log carries a diagnosis, because a failed websocket in node reports a
bare `TypeError` with no reason. The ringmaster probes `/healthz` once per outage to
turn that into something actionable:

```
cannot reach bigtop: ECONNREFUSED                    # nothing listening
cannot reach bigtop: UNABLE_TO_GET_ISSUER_CERT_LOCALLY   # untrusted certificate
cannot reach bigtop: ENOTFOUND                       # bad hostname
bigtop is reachable but refused the uplink - check the room name and token
```

## What has actually been tested

The `wss://` path was verified end to end against a TLS terminator in front of
the bigtop: uplink connected, a bozo joined over TLS, a message reached the
session and the pane stream came back. Certificate verification is on and is
enforced - an untrusted certificate is refused rather than ignored.

A websocket upgrade has since been carried end to end through a real
HTTP-aware proxy - Cloudflare's edge, via `c2c host --tunnel` - so the protocol
survives header rewriting rather than only a TCP pipe.

Still untested specifically: **these two config files.** nginx and Caddy are
not installed on the machine this was built on, so the directives below are
informed by the failure mode rather than proven against it. Check for a `101`
on the first bozo connection.
