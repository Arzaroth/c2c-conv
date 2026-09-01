#!/bin/sh
# The container runs one headless session. c2c host --no-attach returns once
# the session is up, so something has to stay in the foreground: this follows
# the ringmaster's log until that process exits, and turns docker stop into
# c2c stop so bozos are told the session ended rather than seeing it vanish.
set -eu

if [ ! -f "$HOME/.claude/.credentials.json" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat >&2 <<'EOF'
no Claude login in the container.

Mount the host's login (compose.yaml does this):
  -v ~/.claude:/home/c2c/.claude -v ~/.claude.json:/home/c2c/.claude.json

On Linux, logging in on the host first is enough. On macOS the login lives in
the Keychain rather than in that directory, so log in once from inside the
container instead, which writes it into the mounted directory:
  docker compose run --rm --entrypoint claude c2c

Or pass ANTHROPIC_API_KEY.
EOF
  exit 1
fi

c2c host --no-attach --bind 0.0.0.0 "$@"

meta=$(ls -t "$HOME"/.c2c-conv/*/ringmaster.json | head -n 1)
dir=$(dirname "$meta")
session=$(basename "$dir")
pid=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).pid" "$meta")

trap 'c2c stop -s "$session"' TERM INT

echo "[container] following $dir/ringmaster.log - docker stop ends the session"
tail --pid="$pid" -n +1 -f "$dir/ringmaster.log" &
wait $! || true
