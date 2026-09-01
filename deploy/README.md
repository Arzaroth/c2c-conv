# Deploying the bigtop

The bigtop is the only piece meant to live on a server. It is a single node
file with no dependencies, it binds loopback, and it holds no state worth
persisting: rooms exist only while a host is connected.

```sh
useradd --system --home /opt/c2c-conv c2c
git clone <repo> /opt/c2c-conv
install -m644 /opt/c2c-conv/deploy/c2c-bigtop.service /etc/systemd/system/
systemctl enable --now c2c-bigtop
```

Then put TLS in front of it with [Caddyfile](Caddyfile) or
[nginx.conf](nginx.conf), and point hosts at it:

```sh
c2c host --bigtop wss://bigtop.example.com --room standup --token <secret>
```

## What the proxy has to get right

Two things, and only one of them is obvious.

**Pass the upgrade through.** Caddy's `reverse_proxy` does this on its own.
nginx does **not**: without `proxy_set_header Upgrade` and `Connection`, the
handshake returns 200 instead of 101 and every guest sits at "offline"
retrying. That looks like a broken bigtop rather than a proxy problem.

**Do not time out idle connections.** A guest watching without typing sends
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
the bigtop: uplink connected, a guest joined over TLS, a message reached the
session and the pane stream came back. Certificate verification is on and is
enforced - an untrusted certificate is refused rather than ignored.

**Not** verified: a real HTTP-aware reverse proxy. The test used a TLS
terminator that pipes TCP, so it does not exercise nginx or Caddy rewriting
headers, which is exactly where the upgrade gotcha above lives. Treat the two
configs here as informed starting points, and check for a `101` on the first
guest connection.
