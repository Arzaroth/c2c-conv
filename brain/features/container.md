# In a container

```sh
cd ~/my-project
C2C_UID=$(id -u) C2C_GID=$(id -g) docker compose -f ~/repos/c2c-conv/compose.yaml up
```

Compose builds the image on the first `up`, passing `C2C_UID` / `C2C_GID` so the
image user takes your ids. From the c2c-conv checkout, `mise run docker:build`
rebuilds it and `mise run docker:host` runs the compose command for the checkout
directory itself.

The image (`Dockerfile`, `node:24-bookworm-slim`) has node, tmux, git, claude and
cloudflared, and builds c2c inside rather than copying a host `dist/`. It runs
one headless session for the directory compose was started from, over a tunnel
by default, and prints the bozo and whiteface links in its log. `docker stop`
ends the session the way `c2c stop` does (the entrypoint traps TERM).

What `compose.yaml` brings in:

- **The login.** `~/.claude` and `~/.claude.json` are bind-mounted. On macOS the
  login is in the Keychain, so log in once from inside instead:
  `docker compose run --rm --entrypoint claude c2c`. `ANTHROPIC_API_KEY` also
  works; the entrypoint refuses to start with neither.
- **The project**, mounted at the same path it has on the host, so the transcript
  and claude's recorded workspace trust carry over.
- **The port**, published on `127.0.0.1:7331` only. Inside, c2c binds every
  interface (`--bind 0.0.0.0`) and warns; the published port is the boundary.

`C2C_ARGS` replaces the default `--tunnel` (`"--tunnel --yolo"`,
`--bigtop wss://...`). `docker compose exec c2c c2c attach` for the terminal,
`docker compose exec c2c c2c ctl status` for the rest. If claude asks whether to
trust the folder, answer it from the whiteface link: the keypad works for the
whiteface in either mode.

In yolo a bozo runs commands as the container user over the mounted paths,
rather than as you over everything.

## Sources

- `Dockerfile`, `compose.yaml`, `docker/entrypoint.sh`, `mise.toml` (`docker:*`)
