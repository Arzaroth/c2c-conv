# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0, a minor bump marks a change that breaks an existing checkout rather
than adding to it.

## [Unreleased]

## [0.3.0] - 2026-09-02

### Changed

- The build needs `pnpm` and `vite` now. `pnpm-lock.yaml` replaces
  `package-lock.json`, `package.json` pins the package manager, and the mise
  `build` and `check` tasks call the package scripts rather than restating
  them. A new `deps` task runs `pnpm install`, so `mise run install` is the
  whole setup. A checkout that pulls and rebuilds with npm gets a missing
  command.
- vite bundles `web/` into `dist/web`: the page, the client and xterm as one
  hashed script and one stylesheet. The ringmaster and the bigtop serve that
  directory rather than `web/`, so a stale build answers 404 for every page
  until it is rebuilt.
- The web TypeScript config only type-checks; esbuild does the emit.
- The container image installs with a frozen lockfile, prunes for production,
  which empties `node_modules` since every dependency is a dev one, and drops
  the pnpm store.

### Removed

- The two `cdn.jsdelivr.net` tags in the page. xterm ships in the bundle, so a
  bozo's browser loads nothing from outside the session, and a bozo with no
  route out gets a mirror rather than a blank page.
- The hand-written `Terminal` declaration in `web/globals.d.ts`; the types come
  with the package.

### Fixed

- `c2c --version` inside the container image reported a `-dirty` revision for
  code identical to the commit: the entrypoint's executable bit was set at build
  time rather than tracked, and `npm prune` rewrote the lockfile on its way out.

## [0.2.0] - 2026-09-02

### Changed

- The source is TypeScript. `src/`, `bigtop/` and `test/` compile to `dist/`,
  and `bin` points at `dist/src/cli.js`, so a build step is mandatory. A
  `~/.local/bin/c2c` symlink that predates this gets ENOENT until
  `mise run install` is run again.
- Every mise task that runs code builds first, so there is no stale `dist/`
  trap.

### Added

- Shared protocol types in `types/protocol.d.ts`, used by the ringmaster, the
  bigtop, Zavatta and the browser client alike.
- `mise run check` type-checks both builds without emitting. The compiler is
  the lint step.

## [0.1.0] - 2026-09-02

The first release. Everything below arrived between the first commit and the
tag.

### Added

- **The mirror.** `c2c host` runs `claude` in a tmux session on a dedicated
  server (`-L c2c`), streams the pane's bytes through `pipe-pane` to every
  connected bozo, and renders them in a read-only xterm.js in the browser.
  Bozo messages are injected as real keystrokes, so the session records them
  as typed rather than through any wrapper.
- **Two modes.** `gallery` (the default) queues every bozo message for the
  host to release or drop; `yolo` sends it straight in. `spectator` and `ring`
  survive as aliases. The mode lives only in the ringmaster and changes only
  through host control, so a bozo cannot promote itself.
- **Host control without leaving the session.** `prefix+a` releases the next
  waiting message, `prefix+d` drops it, `prefix+y` toggles the mode, and a
  status bar shows the mode, the bozo count and what is waiting. `c2c ctl`
  does the same over a unix control socket: `status`, `list`, `mode`,
  `approve`, `deny`, `approve-next`, `deny-next`, `approve-all`, `deny-all`.
- **Three ways in.** A loopback http+websocket server for ssh forwarding; the
  bigtop, a rendezvous server with rooms for a host behind NAT
  (`--bigtop wss://... --room NAME`); and `--tunnel`, which spawns cloudflared
  and prints a public URL. The tunnel is a child of the ringmaster, so it dies
  with the session. An npm-installed cloudflared is used when one is present.
- **Dialogs from the gallery.** A keypad sends arrow keys, Enter, Escape, Tab
  and digits when the session is asking a question, in yolo mode.
- **History.** The ringmaster tails Claude Code's own session transcript and
  bozos get a history panel: every turn from the start, with tool calls named,
  including turns that predate their arrival.
- **Zavatta, the AI bozo.** An MCP server that joins over the ordinary bozo
  protocol with five tools: `screen`, `history`, `status`, `send`, `press`.
  It has no approve, deny or mode tool on purpose.
- **Headless sessions.** `--no-attach`, `--yolo` and `--mode` start a session
  nobody is attached to. A detached session mints a second link carrying a
  whiteface token: the whiteface runs the ring from the browser, with release,
  drop, the mode switch and the keypad in either mode. One holder at a time;
  the token stays valid so a dropped connection can reclaim the role.
- **A container.** `Dockerfile`, `compose.yaml` and an entrypoint that runs one
  headless session for the directory it is started from, mounts the host's
  login and project at their own paths, and turns `docker stop` into
  `c2c stop`.
- **Deploy configs** for the bigtop: a systemd unit, a Caddyfile and an nginx
  config that pass the websocket upgrade through and never time out an idle
  bozo.
- **Tooling.** mise tasks for install, test, check, host, local, bigtop,
  zavatta, status, invite, stop and the docker pair. `c2c --version` reports
  the release, the git revision and the checkout it runs from, marked `-dirty`
  when the tree has changes.
- A tmux integration suite that drives a real tmux server and pins the bugs
  that cost the most time: text injected into copy mode, bozo text read as a
  key name, bindings resolving the wrong session.
- The circus vocabulary: bigtop, ringmaster, bozo, whiteface, Zavatta, and
  HOINK for the greeting.

### Security

- Tokens are compared in constant time, and the bigtop requires them to be 8
  to 256 characters. Rooms are capped at 64 with names limited to 64 characters
  of `[\w.-]`.
- Bozo input is bounded: websocket frames at 1 MB including declared lengths
  and reassembled fragments, messages at 8000 characters, the pending queue at
  50, and bozos at 30.
- Static paths on both servers are resolved and checked against the web root
  rather than having `../` stripped.
- TLS certificate verification on the bigtop uplink is enforced, and failures
  are diagnosed rather than retried silently.
- A non-loopback `--bind` prints a warning; a headless session in yolo prints
  a stronger one, since the link is then the whole security boundary.
- The whiteface token is a separate secret from the share link, so handing
  someone the session does not hand them control of it, and every host action
  is checked in the ringmaster rather than the UI.
- Every text injection waits for an idle prompt and is held, with the host
  told why, when the pane is in a dialog, in copy mode, or holding the host's
  own unsent draft.

[Unreleased]: https://box.arzaroth.com/Arzaroth/c2c-conv/compare/v0.3.0...HEAD
[0.3.0]: https://box.arzaroth.com/Arzaroth/c2c-conv/compare/v0.2.0...v0.3.0
[0.2.0]: https://box.arzaroth.com/Arzaroth/c2c-conv/compare/v0.1.0...v0.2.0
[0.1.0]: https://box.arzaroth.com/Arzaroth/c2c-conv/releases/tag/v0.1.0
