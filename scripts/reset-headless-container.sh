#!/usr/bin/env bash
#
# Reset a headless container back to a bare host: SSH in, stop any running
# harness-server, uninstall it (~/.harness-server + the /usr/local/bin
# symlink), and wipe the server's data dir (~/.harness) plus agent state
# (~/.claude, ~/.codex) so nothing carries over. The container's plumbing —
# SSH, the Node runtime, the installed claude/codex binaries, the repo clone —
# is left intact, so you can immediately re-provision it from the Harness app
# (SSH bootstrap) without the full teardown + rebuild that
# `docker rm -f` + `run-headless-container.sh` costs. Note that wiping
# ~/.claude / ~/.codex clears their auth, so you'll re-authenticate the agents
# after a reset.
#
# Usage: ./scripts/reset-headless-container.sh <linux/arm64|linux/amd64>
# Example:
#   ./scripts/reset-headless-container.sh linux/arm64   # ssh root@localhost:2222
#   ./scripts/reset-headless-container.sh linux/amd64   # ssh root@localhost:2223
#
# Connects over SSH (not docker exec) so it exercises the same path the real
# remote-reset flow would — key-based as root, using the same key
# run-headless-container.sh injected. Idempotent: safe if nothing is
# installed or running.

set -euo pipefail

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n=== %s ===\n' "$*"; }

# --- parameterize on platform (mirror run-headless-container.sh) ---
PLATFORM="${1:-}"
case "$PLATFORM" in
  linux/arm64) SSH_PORT=2222 ;;
  linux/amd64) SSH_PORT=2223 ;;
  *) err "usage: $0 <linux/arm64|linux/amd64>" ;;
esac
NAME="harness_${PLATFORM//\//-}"

# --- resolve the private key whose .pub run-headless-container.sh injected ---
# Same discovery order, so we present the key the container authorized.
KEY_FILE=""
for f in id_ed25519 id_rsa id_ecdsa; do
  if [ -f "$HOME/.ssh/$f" ]; then KEY_FILE="$HOME/.ssh/$f"; break; fi
done
[ -n "$KEY_FILE" ] || err "no SSH private key in ~/.ssh (looked for id_ed25519/id_rsa/id_ecdsa)"

# Container host keys change on every rebuild, so don't pin them.
SSH_OPTS=(-p "$SSH_PORT" -i "$KEY_FILE"
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

log "resetting $NAME via ssh root@localhost:$SSH_PORT"

# Remote reset. Variable refs (e.g. "$INSTALL_DIR/...") stay literal in this
# heredoc until the REMOTE shell expands them — so pkill's expanded pattern
# can't match this script's own command line (no self-kill foot-gun).
ssh "${SSH_OPTS[@]}" root@localhost 'sh -s' <<'REMOTE'
set -u
INSTALL_DIR="${HARNESS_SERVER_INSTALL_DIR:-$HOME/.harness-server}"
stopped=0

# 1. Stop the server we recorded in state.json (the detached node process).
if [ -f "$INSTALL_DIR/state.json" ]; then
  pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$INSTALL_DIR/state.json")
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null && stopped=1
    echo "stopped harness-server pid $pid"
  fi
fi

# 2. Backstop: kill any straggler running the bundled server entrypoint. The
#    pattern is the expanded install path, which this heredoc never contains
#    literally (it references $INSTALL_DIR), so pkill won't match itself.
if pkill -f "$INSTALL_DIR/lib/main/index.js" 2>/dev/null; then
  stopped=1
  echo "stopped straggler harness-server process(es)"
fi

# 3. Uninstall: the install tree + the best-effort /usr/local/bin symlink.
if [ -e "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "removed $INSTALL_DIR"
else
  echo "no install at $INSTALL_DIR"
fi
if [ -L /usr/local/bin/harness-server ] || [ -e /usr/local/bin/harness-server ]; then
  rm -f /usr/local/bin/harness-server 2>/dev/null && echo "removed /usr/local/bin/harness-server symlink" || true
fi

# 4. Wipe the server data dir + agent state so nothing carries into the next
#    provision. ~/.harness is the headless server's HARNESS_DATA_DIR (config,
#    secrets, worktree/pane state); ~/.claude and ~/.codex hold the agents'
#    auth + config. (HARNESS_DATA_DIR can be overridden, but the bootstrap
#    starts the server with the default ~/.harness.)
for d in "$HOME/.harness" "$HOME/.claude" "$HOME/.codex"; do
  if [ -e "$d" ]; then
    rm -rf "$d"
    echo "removed $d"
  fi
done

echo "reset complete (stopped=$stopped)"
REMOTE

log "done — $NAME is a bare host again; re-provision from the Harness app"
