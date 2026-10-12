# Operations

## Build

The source is TypeScript, so there is a compile step: `pnpm run build` runs
`tsc -p tsconfig.json`, then `vite build`, then marks `dist/src/cli.js` and
`dist/bigtop/server.js` executable. `dist/` is gitignored. Every mise task that
runs code depends on `build`, so there is no stale-`dist/` trap.

| Task | What |
|---|---|
| `mise run deps` | `pnpm install` |
| `mise run build` | compile to `dist/`, bundle `web/` to `dist/web` |
| `mise run check` | `pnpm check`: type-check both builds without emitting |
| `mise run test` | build, then `node --test dist/test/*.test.js` |
| `mise run install` | build, then symlink `~/.local/bin/c2c` to `dist/src/cli.js` |
| `mise run host` / `local` | share a session here, over a tunnel / loopback only |
| `mise run bigtop` | a bigtop on `127.0.0.1:8080` |
| `mise run zavatta` | join the running session as an MCP bozo on stdio |
| `mise run status` / `invite` / `stop` | `c2c ctl status`, `c2c invite`, `c2c stop` |
| `mise run docker:build` / `docker:host` | see [features/container.md](features/container.md) |

Because `c2c` is normally a symlink into a checkout, `c2c --version` prints the
package version plus the git revision, with `-dirty` when the tree has changes
(`src/version.ts`).

## The gate

```bash
pnpm check     # both TypeScript builds
pnpm test      # builds, then the whole suite, tmux integration included
```

`pnpm test` needs `tmux` on PATH: `test/tmux.integration.test.ts` drives a real
tmux server, and without one it fails rather than skipping
([architecture/testing.md](architecture/testing.md)).

## CI

`.github/workflows/ci.yml`, on every push and pull request (GitHub mirror):
Node 24, `apt-get install tmux`, `corepack enable`,
`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`. tmux is installed
explicitly rather than assumed from the runner image. There is no coverage
floor and no release workflow.

## Repository and remotes

`origin` is the Forgejo repository; GitHub (`Arzaroth/c2c-conv`) is a push
mirror, and the one CI runs on. Work lands directly on `master` as layered
`[master] type(scope): ...` commits.

## Releases

By hand, there is no release task. The version lives in `package.json` only;
`CHANGELOG.md` follows Keep a Changelog, and the README's `c2c --version`
example quotes it. The project is pre-1.0 and the versioning rule is written in
the CHANGELOG header: **a minor bump marks a change that breaks an existing
checkout**, everything additive is a patch (see
[decisions.md](decisions.md#0013-pre-10-a-minor-means-a-checkout-breaks)). A
release is a `[master] chore(release): x.y.z` commit whose body explains the bump
in prose, plus an annotated `vX.Y.Z` tag whose message, since 0.3.1, is
`c2c-conv x.y.z - <theme>`. The project's `release` skill walks it.

## Deploying a bigtop

The only piece meant to live on a server. A built checkout, a system user, and
`deploy/c2c-bigtop.service` pointing at `dist/bigtop/server.js`; it binds
loopback behind TLS. `deploy/Caddyfile` and `deploy/nginx.conf` carry the two
things a proxy must get right for websockets, and `deploy/README.md` says which
parts were tested against a real proxy. Rebuild on every update:
`git pull && pnpm install --frozen-lockfile && pnpm run build && systemctl restart c2c-bigtop`
(`deploy/README.md` still says `npm ci`, which fails without a
`package-lock.json`; see `TODO.md`).
`GET /healthz` answers `{"ok":true,"rooms":N}`. Protocol and limits:
[architecture/transports.md](architecture/transports.md#the-bigtop).

## Sources

- `package.json`, `mise.toml`, `.github/workflows/ci.yml`
- `src/version.ts`
- `deploy/README.md`, `deploy/c2c-bigtop.service`, `deploy/Caddyfile`, `deploy/nginx.conf`
- `CHANGELOG.md` (header)
