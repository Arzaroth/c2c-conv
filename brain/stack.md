# Stack

| Layer | What | Pinned in |
|---|---|---|
| Runtime | Node 24 in development and CI, `>=20` declared | `mise.toml`, `package.json` `engines` |
| Language | TypeScript (ESM, `"type": "module"`) | `package.json`, `tsconfig.json`, `tsconfig.web.json` |
| Client bundle | vite, bundling `web/` with xterm.js into `dist/web` | `vite.config.ts` |
| Terminal emulator (browser) | `@xterm/xterm` 5.5.0, exact pin | `package.json` |
| Package manager | pnpm 11 (`packageManager` field) | `package.json`, `mise.toml` |
| Task runner | mise | `mise.toml` |
| Host-side tools | `tmux`, `claude`; optionally `cloudflared` | README "Requirements" |
| Tests | `node:test`, run against the compiled `dist/test/*.test.js` | `package.json` `test` |

## No runtime dependencies

Every entry in `package.json` is a `devDependency`. TypeScript, vite and xterm
exist only to produce `dist/`; once built, nothing runs from `node_modules`. The
consequences are deliberate:

- The websocket server and client framing are hand-rolled on `node:http`
  upgrades ([architecture/protocol.md](architecture/protocol.md)) rather than
  pulled from `ws`.
- xterm is folded into the page by vite, so a bozo's browser loads nothing from
  a CDN.
- The bigtop deploys as `dist/bigtop/server.js`, the `src/` modules it imports
  (`ws`, `secret`, `policy`, `root`) and `dist/web`, with no `node_modules`
  ([operations.md](operations.md#deploying-a-bigtop)).
- `cloudflared` is a binary c2c resolves, not a dependency it installs
  ([architecture/transports.md](architecture/transports.md#a-cloudflared-tunnel)).

## Two TypeScript builds

`tsconfig.json` compiles `src/`, `bigtop/` and `test/` to `dist/`.
`tsconfig.web.json` type-checks `web/` for the browser. `types/protocol.d.ts` is
shared by both and has no imports or exports, so every wire type is ambient and
the web client uses it without a module loader. There is no linter: `pnpm check`
(both builds, `--noEmit`) is the lint step.

## Layout

```
src/            the c2c CLI, the ringmaster and everything it drives
src/transport/  LocalTransport, BigtopTransport
bigtop/         the rendezvous server
web/            the bozo client (index.html, client.ts, circus.ts, lane.ts)
types/          protocol.d.ts, the wire shared by every build
test/           node:test suites, including the real-tmux integration test
deploy/         systemd unit, Caddy and nginx configs for a bigtop
docker/         the container entrypoint
```

## Sources

- `package.json`, `mise.toml`, `tsconfig.json`, `tsconfig.web.json`, `vite.config.ts`
- `types/protocol.d.ts`
- `src/root.ts` (`PROJECT_ROOT`, `WEB_ROOT`)
