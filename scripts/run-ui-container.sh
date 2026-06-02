#!/usr/bin/env bash
#
# Start + provision a linux/arm64 container that runs the full Harness Electron
# UI on a virtual display (Xvfb), exposed to the host over VNC.
#
# It runs THIS checkout's build — your local Harness, not a fresh clone — so
# whatever you've committed here is what shows up in the container. The app is
# built on the host (electron-vite produces plain JS in out/, which runs fine
# on linux) and copied in; the container only npm-installs to get the
# linux-native deps (electron, node-pty). Separately it clones a repo as a test
# workspace for Harness to open and create worktrees from. Unlike
# run-headless-container.sh (standalone harness-server + web client), this is
# the desktop GUI under Xvfb + fluxbox + x11vnc, driven from a VNC viewer.
#
# Usage: ./scripts/run-ui-container.sh
#
# Connect from the host once it's up (macOS ships a VNC client):
#   open vnc://localhost:5901        # then enter the VNC password
#
# Env overrides:
#   HARNESS_CLONE_URL       test-workspace repo to clone (default: upstream
#                           frenchie4111/harness) — NOT the app that runs
#   HARNESS_VNC_PORT        host port to map to the container's :5900 (default 5901)
#   HARNESS_VNC_PASSWORD    VNC password (default: harness)
#   HARNESS_UI_GEOMETRY     Xvfb screen geometry (default: 1600x1000)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n=== %s ===\n' "$*"; }

command -v docker >/dev/null 2>&1 || err "docker is required but not installed"

# linux/arm64 only — VM-native on Apple Silicon, so the Electron build is quick.
PLATFORM="linux/arm64"
IMAGE="ubuntu:24.04"
NAME="harness_ui"

VNC_HOST_PORT="${HARNESS_VNC_PORT:-5901}"     # host side; x11vnc listens on 5900 inside
NOVNC_HOST_PORT="${HARNESS_NOVNC_PORT:-6080}"  # browser noVNC endpoint (websockify -> 5900)
VNC_PW="${HARNESS_VNC_PASSWORD:-harness}"
GEOMETRY="${HARNESS_UI_GEOMETRY:-1600x1000}"
CLONE_URL="${HARNESS_CLONE_URL:-https://github.com/frenchie4111/harness.git}"
CLONE_DEST="$(basename "$CLONE_URL" .git)"
APP_DIR="/opt/harness-app"   # the host's build runs from here; the clone is separate

# --- guard against an existing container of the same name ---
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  err "container '$NAME' already exists — remove it first: docker rm -f $NAME"
fi

# --- build the local UI on the host; this is the version the container runs.
#     out/ is plain bundled JS (no native code), so it runs in the linux
#     container against the linux-native node_modules installed below. ---
log "building the local Harness UI on the host (electron-vite build)"
( cd "$REPO_ROOT" && npx electron-vite build ) \
  || err "host build failed — run 'npm install --legacy-peer-deps' in the repo first"
[ -f "$REPO_ROOT/out/main/index.js" ] || err "build produced no out/main/index.js"

# --- start the container (detached, keepalive). --shm-size avoids Chromium's
#     /dev/shm exhaustion crashes. ---
log "starting container $NAME ($PLATFORM, VNC $VNC_HOST_PORT, noVNC $NOVNC_HOST_PORT)"
docker run -dit --name "$NAME" \
  --platform "$PLATFORM" \
  --shm-size=1g \
  -p "$VNC_HOST_PORT:5900" \
  -p "$NOVNC_HOST_PORT:6080" \
  "$IMAGE" sleep infinity >/dev/null

# --- prerequisites: virtual display + VNC + Electron's runtime libs + Node 22.
#     The *t64 package names are the Ubuntu 24.04 (time_t transition) variants. ---
log "installing prerequisites (Xvfb, x11vnc, Electron libs, Node 22)"
docker exec "$NAME" bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    xvfb x11vnc fluxbox feh x11-utils autocutsel novnc websockify dbus dbus-x11 \
    zsh curl ca-certificates git python3 make g++ \
    libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0t64 \
    libdrm2 libgbm1 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libxkbcommon0 libpango-1.0-0 libcairo2 libxcomposite1 \
    libxdamage1 libxrandr2 libxfixes3
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs'

# --- claude + codex: the UI's terminal/chat tabs spawn `claude` from PATH ---
log "installing claude + codex"
docker exec "$NAME" bash -lc '
  set -e
  npm install -g @anthropic-ai/claude-code @openai/codex
  claude --version && codex --version'

# --- install the host's build as the app + its linux-native deps ---
# Snapshot the committed source (gitignored node_modules/out excluded), overlay
# the out/ just built on the host, then npm install so node-pty + electron are
# the linux/arm64 builds. This runs YOUR local Harness, not a fresh clone.
log "installing the local build into the container ($APP_DIR)"
git -C "$REPO_ROOT" archive --format=tar HEAD \
  | docker exec -i "$NAME" bash -lc "mkdir -p $APP_DIR && tar -x -C $APP_DIR"
docker cp "$REPO_ROOT/out" "$NAME":"$APP_DIR/out"
docker exec "$NAME" bash -lc "cd $APP_DIR && npm install --legacy-peer-deps"

# --- clone a repo as a test workspace for Harness to open (not the app) ---
log "cloning $CLONE_URL as a test workspace (~/$CLONE_DEST)"
if docker exec "$NAME" bash -lc "git clone '$CLONE_URL' ~/$CLONE_DEST"; then
  REPO_NOTE="A clone of $CLONE_URL is at ~/$CLONE_DEST in the container — point Harness at that path to create worktrees."
else
  REPO_NOTE="(test-workspace clone failed — for a private fork set HARNESS_CLONE_URL, or clone one over SSH.)"
  printf 'warning: test-workspace clone failed; the UI is otherwise ready\n' >&2
fi

# --- store the VNC password ---
log "configuring VNC (password auth)"
docker exec "$NAME" bash -lc "mkdir -p ~/.vnc && x11vnc -storepasswd '$VNC_PW' ~/.vnc/passwd"

# --- install the display+UI launcher ---
# Brings up Xvfb, a window manager, x11vnc, then the Electron app. The app runs
# as root with the sandbox disabled (same ELECTRON_DISABLE_SANDBOX the repo's
# dev script uses) and software GL, since there's no GPU under Xvfb.
docker exec -i "$NAME" bash -lc 'cat > /usr/local/bin/start-ui.sh && chmod +x /usr/local/bin/start-ui.sh' <<LAUNCH
#!/bin/bash
set -e
export DISPLAY=:99
export ELECTRON_DISABLE_SANDBOX=1
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 ${GEOMETRY}x24 -nolisten tcp >/var/log/xvfb.log 2>&1 &
for _ in \$(seq 1 30); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.5; done
# Paint the root window with fluxbox's own fbsetroot (bundled, no deps) so it
# doesn't fall back to fbsetbg — which warns when no image-setter is installed.
mkdir -p /root/.fluxbox
printf 'session.screen0.rootCommand: fbsetroot -solid #1e1e1e\n' > /root/.fluxbox/init
fluxbox >/var/log/fluxbox.log 2>&1 &
# Keep the X CLIPBOARD (what Electron uses) and PRIMARY selections in sync with
# the cut buffer x11vnc bridges to VNC, so copy+paste works to/from the host.
autocutsel -fork
autocutsel -selection PRIMARY -fork
x11vnc -display :99 -forever -shared -rfbport 5900 -rfbauth /root/.vnc/passwd \
  -bg -o /var/log/x11vnc.log
# noVNC: serve the browser VNC client and proxy its WebSocket to x11vnc:5900.
websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/websockify.log 2>&1 &
cd ${APP_DIR}
dbus-run-session -- node_modules/.bin/electron . \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >/var/log/harness-ui.log 2>&1
LAUNCH

# --- launch the UI stack (detached; container PID 1 stays sleep infinity) ---
log "launching the Harness UI"
docker exec -d "$NAME" /usr/local/bin/start-ui.sh

cat <<EOF

=== container '$NAME' is up and the Harness UI is starting ===

Connect from the host (give Electron a few seconds to paint). Password: $VNC_PW

  Browser (noVNC):  http://localhost:$NOVNC_HOST_PORT/vnc.html
  VNC client:       localhost:$VNC_HOST_PORT   (e.g. open vnc://localhost:$VNC_HOST_PORT)

For copy+paste prefer the browser (noVNC's clipboard panel) or a real VNC
client like TigerVNC/RealVNC — macOS Screen Sharing greys out shared
clipboard for non-Apple VNC servers.

This is your local build (from $REPO_ROOT). $REPO_NOTE

Logs (inside the container):

  docker exec $NAME tail -f /var/log/harness-ui.log   # Electron stdout/stderr
  docker exec $NAME cat /var/log/x11vnc.log           # VNC server
  docker exec $NAME cat /var/log/websockify.log       # noVNC proxy

Restart the UI (e.g. after a crash):

  docker exec -d $NAME /usr/local/bin/start-ui.sh

Shell in:

  docker exec -it $NAME bash

Tear down when finished:

  docker rm -f $NAME
EOF
