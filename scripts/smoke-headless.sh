#!/usr/bin/env bash
# End-to-end smoke test for the headless server.
#
# Launches dist-headless/main/index.js on an ephemeral port + localhost,
# parses the [web-client] URL out of stdout, then delegates to
# scripts/web-smoke.mjs and scripts/ws-smoke.mjs for HTTP + WS
# validation. Finally SIGTERMs the server and confirms it exits within
# 5s (no zombies).
#
# Run locally:  npm run build:headless && bash scripts/smoke-headless.sh
# Run in CI:    same — invoked from .github/workflows/ci.yml.
#
# Exit codes: 0 = all checks passed; non-zero = a check failed (the
# server log is dumped to stderr on URL-parse failure).

set -euo pipefail

BUNDLE=dist-headless/main/index.js

# Static check, before we even launch: the bundle must not require
# `electron` eagerly.
#
# `electron` is an external in vite.headless.config.ts on the premise that
# every call site is gated on Electron mode and never runs headless. A
# STATIC `import … from 'electron'` silently breaks that premise — rollup
# hoists it into the CJS require preamble, so it fires the instant Node
# loads the bundle, before any gate. That is how v2.13.0/v2.13.1 shipped a
# harness-server that died with "Cannot find module 'electron'" on every
# remote.
#
# Running the server below cannot catch it: CI runs from the repo root,
# where node_modules/electron resolves fine. Only the tarball (which ships
# no electron) hits the failure, so this grep is the guard. Lazy access via
# createRequire compiles to a variable call, not the literal below, so the
# supported pattern passes.
# Comment lines are excluded: the bundle is built with minify:false, so
# prose that merely mentions the call survives into the output.
EAGER_ELECTRON="$(
  grep -nE "require\((\"|')electron(\"|')\)" "$BUNDLE" \
    | grep -vE '^[0-9]+:[[:space:]]*(\*|//|/\*)' || true
)"
if [ -n "$EAGER_ELECTRON" ]; then
  echo "::error::$BUNDLE requires electron at load time." >&2
  echo "  This crashes harness-server on any non-Electron host." >&2
  echo "  Fix: resolve electron lazily via createRequire behind a" >&2
  echo "  detectRuntime() === 'electron' gate (see wake-lock-controller.ts)." >&2
  printf '%s\n' "$EAGER_ELECTRON" >&2
  exit 1
fi
echo "ok: no load-time electron require in $BUNDLE"

# Isolated data dir so we don't touch ~/.harness on a dev box or the
# runner's $HOME in CI.
LOG="${HARNESS_SMOKE_LOG:-/tmp/harness-server.log}"
HARNESS_DATA_DIR="$(mktemp -d)"
export HARNESS_DATA_DIR

node "$BUNDLE" --port 0 --host 127.0.0.1 > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait up to 15s for the URL line. Format is
#   "[web-client] open http://127.0.0.1:<port>/?token=<token>"
# emitted from src/main/index.ts in the webHttpServer.listen callback.
# If the log shape changes, this fails loudly (which is what we want,
# since the Settings UI and other tooling read the same line).
URL=""
for _ in $(seq 1 75); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[a-f0-9]+' "$LOG" | head -1 || true)"
  if [ -n "$URL" ]; then break; fi
  sleep 0.2
done
if [ -z "$URL" ]; then
  echo "::error::headless server did not advertise a URL within 15s" >&2
  echo "--- server log ---" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "server up at $URL"

# Split URL into host:port + token for the existing smoke scripts.
# URL shape is fixed (http://127.0.0.1:<port>/?token=<hex>), no need
# for a real URL parser.
HOST_PORT="${URL#http://}"
HOST_PORT="${HOST_PORT%%/*}"
TOKEN="${URL##*token=}"
PORT="${HOST_PORT##*:}"

# 1+2. web-client HTTP: auth gate + HTML + asset reachability.
node scripts/web-smoke.mjs "$HOST_PORT" "$TOKEN"

# 3. WS upgrade + snapshot round-trip.
node scripts/ws-smoke.mjs "$TOKEN" "$PORT"

# 4. Clean shutdown — SIGTERM should exit within 5s. Catches "server
# hangs on SIGTERM" bugs that would leave zombies in CI.
kill -TERM "$SERVER_PID"
for _ in $(seq 1 25); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "::error::server did not exit on SIGTERM within 5s" >&2
  kill -9 "$SERVER_PID" || true
  exit 1
fi
echo "clean shutdown OK"
trap - EXIT
