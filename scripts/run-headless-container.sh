#!/usr/bin/env bash
#
# Start a clean Linux container that acts as a REMOTE HOST for Harness's SSH
# bootstrap. It installs prerequisites + claude + codex, enables key-based
# SSH, and clones the harness repo in so the server has something to manage —
# but it deliberately does NOT install harness-server and copies no tarball
# in. Provisioning is Harness's job: add this container as an SSH backend
# ('+' in the backend chip strip) and Harness ships its own install-headless.sh
# over the wire, then either uploads a locally-built tarball or pulls a
# published release inside the container.
#
# Usage: ./scripts/run-headless-container.sh <linux/arm64|linux/amd64>
# Example:
#   ./scripts/run-headless-container.sh linux/arm64
#   ./scripts/run-headless-container.sh linux/amd64
#
# Each platform gets its own ports + container name, so you can run both at
# once:
#   linux/arm64  -> server 37291, ssh 2222, container harness_linux-arm64
#   linux/amd64  -> server 37292, ssh 2223, container harness_linux-amd64
#
# SSH is always enabled (key-based, as root): your public key from ~/.ssh is
# injected so you can `ssh -p <ssh-port> root@localhost`, and Harness's SSH
# bootstrap drives the rest exactly like a real remote host.
#
# To exercise Harness's upload mode, build the matching tarball first with
# `npm run pack:headless:linux <platform>`; with no local tarball Harness
# falls back to downloading a published release inside the container.
#
# Auth for claude + codex is left to you — exec/ssh into the container and
# authenticate however you normally do.

set -euo pipefail

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n=== %s ===\n' "$*"; }

# --- parameterize on platform ---
PLATFORM="${1:-}"
case "$PLATFORM" in
  linux/arm64) PORT=37291; SSH_PORT=2222 ;;
  linux/amd64) PORT=37292; SSH_PORT=2223 ;;
  *) err "usage: $0 <linux/arm64|linux/amd64>" ;;
esac

# ubuntu:24.04 is multi-arch; --platform selects the matching arch variant.
IMAGE="ubuntu:24.04"
NAME="harness_${PLATFORM//\//-}"   # harness_linux-arm64 / harness_linux-amd64

command -v docker >/dev/null 2>&1 || err "docker is required but not installed"

# --- resolve an SSH public key on the host (fail fast) ---
PUBKEY_FILE=""
for f in id_ed25519 id_rsa id_ecdsa; do
  if [ -f "$HOME/.ssh/$f.pub" ]; then PUBKEY_FILE="$HOME/.ssh/$f.pub"; break; fi
done
[ -n "$PUBKEY_FILE" ] || err "no SSH public key in ~/.ssh (looked for id_ed25519/id_rsa/id_ecdsa .pub) — generate one with: ssh-keygen -t ed25519"

# --- repo to clone into the container so the server has something to manage ---
# Defaults to the upstream repo; override with HARNESS_CLONE_URL.
CLONE_URL="${HARNESS_CLONE_URL:-https://github.com/frenchie4111/harness.git}"
CLONE_DEST="$(basename "$CLONE_URL" .git)"

# --- guard against an existing container of the same name ---
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  err "container '$NAME' already exists — remove it first: docker rm -f $NAME"
fi

# --- start the container (detached, keepalive) ---
log "starting container $NAME ($PLATFORM, server $PORT, ssh $SSH_PORT)"
docker run -dit --name "$NAME" \
  --platform "$PLATFORM" \
  -p "$PORT:$PORT" \
  -p "$SSH_PORT:22" \
  "$IMAGE" sleep infinity >/dev/null

# --- prerequisites + Node 22 + sshd ---
log "installing prerequisites (curl, git, openssh-server, Node 22)"
docker exec "$NAME" bash -lc '
  set -e
  apt-get update
  apt-get install -y --no-install-recommends curl ca-certificates git openssh-server
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs'

# --- enable SSH: inject the host public key, start sshd (no systemd here) ---
# Pipe the key in over stdin and write it as root. `docker cp` would preserve
# the host file's numeric UID, leaving authorized_keys owned by a non-root uid
# — sshd's StrictModes then ignores it and silently falls back to a password
# prompt.
log "enabling SSH (port $SSH_PORT, key from $PUBKEY_FILE)"
docker exec -i "$NAME" bash -lc '
  set -e
  mkdir -p /root/.ssh /run/sshd
  cat > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  chown -R root:root /root/.ssh
  /usr/sbin/sshd' < "$PUBKEY_FILE"

# --- claude + codex ---
log "installing claude + codex"
docker exec "$NAME" bash -lc '
  set -e
  npm install -g @anthropic-ai/claude-code @openai/codex
  claude --version && codex --version'

# harness-server is intentionally NOT installed here — Harness's SSH bootstrap
# ships its own install-headless.sh and the server tarball when you add this
# container as a backend. That's the whole point: this container is a faithful
# bare remote host, provisioned end-to-end by Harness.

# --- clone the harness repo so the server has a repo to manage worktrees from ---
log "cloning $CLONE_URL into the container (~/$CLONE_DEST)"
if docker exec "$NAME" bash -lc "git clone '$CLONE_URL' ~/$CLONE_DEST"; then
  REPO_NOTE="A clone of $CLONE_URL is at ~/$CLONE_DEST in the container — point Harness at that path to create worktrees."
else
  REPO_NOTE="(repo clone failed — for a private fork, set HARNESS_CLONE_URL or clone one manually over SSH.)"
  printf 'warning: repo clone failed; container is otherwise ready\n' >&2
fi

# --- instructions (not executed) ---
cat <<EOF

=== container '$NAME' is up — a bare remote host, ready for Harness ===

This container has SSH + Node + claude/codex + a repo clone, but NO
harness-server yet. Add it as an SSH backend in Harness and it will ship its
own install-headless.sh and the server tarball for you (uploading a local
linux-${PLATFORM##*/} tarball if you built one, else downloading a release).

First make 'ssh $NAME' work — these containers are ephemeral, so the host key
changes on every rebuild. Add to ~/.ssh/config:

  Host $NAME
    HostName localhost
    Port $SSH_PORT
    User root
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null

Then in the Harness desktop app:

  '+' in the backend chip strip (or File -> Add Backend...) -> SSH host tab
  Pick / type:  $NAME   (or:  root@localhost:$SSH_PORT)

Harness SSHes in, provisions harness-server, starts it bound to 127.0.0.1,
and tunnels it back over SSH — no need to publish the server port or copy a
token by hand. (The -p $PORT:$PORT mapping is only here if you'd rather run
'docker exec -it $NAME harness-server --host 0.0.0.0 --port $PORT' manually
and connect a browser to http://localhost:$PORT after provisioning.)

$REPO_NOTE

Auth — authenticate claude + codex inside the container as you normally do:

  docker exec -it $NAME bash    # or: ssh $NAME

Note: sshd is started directly (no systemd here), so after a container
restart re-run it with:  docker exec $NAME /usr/sbin/sshd

Tear down when finished:

  docker rm -f $NAME
EOF
