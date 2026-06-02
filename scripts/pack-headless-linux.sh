#!/usr/bin/env bash
#
# Build Linux harness-server tarballs from a macOS (or any) host.
#
# Usage: ./scripts/pack-headless-linux.sh [platform ...]
# Example:
#   ./scripts/pack-headless-linux.sh                  # both arm64 + amd64
#   ./scripts/pack-headless-linux.sh linux/arm64      # just arm64
#
# Why this isn't a single cross-compile: harness-server bundles two
# arch-specific artifacts — node-pty (a native C++ addon) and the
# platform-gated @anthropic-ai/claude-code-<arch> prebuilt. Everything ELSE in
# the tarball (the vite-bundled main + web-client JS, the `ws` dep, node-pty's
# own JS) is byte-identical across arches, and the pinned Node binary is just a
# per-arch download from nodejs.org.
#
# So we don't pay the full `npm ci` + `build:headless` cost once per arch.
# Instead:
#   Phase 1 (native arch, full speed): one `npm ci` + `build:headless` into a
#           shared Linux node_modules volume. On Apple Silicon the linux/arm64
#           container is VM-native (no Rosetta), so this is the fast path even
#           when the only tarball you want is amd64.
#   Phase 2 (per target arch): just `npm run pack:headless` against that shared
#           volume. For a non-native arch the only emulated work is compiling
#           the one node-pty addon and downloading that arch's claude prebuilt
#           + Node binary — minutes, not the ~30 min an emulated `npm ci` costs.
#
# The shared node_modules lives in an ephemeral named volume (removed on exit),
# never the host's macOS node_modules, so the Linux and Electron ABIs never
# mix.
#
# CI (.github/workflows/headless-release.yml) builds each platform on a native
# runner via `npm run pack:headless` directly and does NOT use this script —
# this is a local-dev convenience only.
#
# Output (on the host):
#   release/headless/harness-server-<version>-linux-arm64.tar.gz (+ .sha256)
#   release/headless/harness-server-<version>-linux-x64.tar.gz   (+ .sha256)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n=== %s ===\n' "$*"; }

command -v docker >/dev/null 2>&1 || err "docker is required but not installed"

# Default to both arches; allow overriding via args (e.g. linux/arm64).
if [ "$#" -gt 0 ]; then
  PLATFORMS=("$@")
else
  PLATFORMS=("linux/arm64" "linux/amd64")
fi

# The docker platform matching the host arch runs at full speed; the other is
# emulated (QEMU/Rosetta). Build the shared deps on the native one so the
# expensive npm ci + vite build never runs under emulation.
case "$(uname -m)" in
  arm64|aarch64) NATIVE_PLATFORM="linux/arm64" ;;
  x86_64|amd64)  NATIVE_PLATFORM="linux/amd64" ;;
  *)             NATIVE_PLATFORM="${PLATFORMS[0]}" ;;
esac

# node:22 is the full (buildpack-deps) variant and already ships g++/make/
# python3 for node-gyp; only apt-install if a future image drops them.
IMAGE="node:22"
ENSURE_TOOLCHAIN='command -v g++ >/dev/null && command -v make >/dev/null && command -v python3 >/dev/null || {
    apt-get update && apt-get install -y --no-install-recommends python3 make g++; }'

claude_pkg_arch() {
  case "$1" in
    linux/arm64) echo "linux-arm64" ;;
    linux/amd64) echo "linux-x64" ;;
    *) err "unsupported platform '$1' (expected linux/arm64 or linux/amd64)" ;;
  esac
}

# --- shared Linux node_modules: ephemeral named volume, never the host tree ---
NM_VOL="harness_headless_nm_$$"
docker volume create "$NM_VOL" >/dev/null
cleanup() { docker volume rm -f "$NM_VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run_in() {  # run_in <platform> <bash-script>
  docker run --rm \
    --platform "$1" \
    -v "$REPO_ROOT":/src \
    -v "$NM_VOL":/src/node_modules \
    -w /src \
    "$IMAGE" \
    bash -lc "$2"
}

# --- phase 1: install + build once on the native arch (output is arch-free) ---
log "phase 1: npm ci + build:headless on $NATIVE_PLATFORM (shared deps)"
run_in "$NATIVE_PLATFORM" "set -e
  $ENSURE_TOOLCHAIN
  npm ci --legacy-peer-deps
  npm run build:headless"

# --- phase 2: assemble one tarball per target arch from the shared deps ---
for platform in "${PLATFORMS[@]}"; do
  arch="$(claude_pkg_arch "$platform")"
  log "phase 2: pack $platform"
  run_in "$platform" "set -e
    $ENSURE_TOOLCHAIN
    # Stage this arch's claude prebuilt if the shared tree lacks it (the native
    # arch's came in via npm ci). Download + unpack only — the binary never
    # runs here — so it's cheap even under emulation. No --os/--cpu override is
    # needed because the container's own arch already matches the package.
    if [ ! -d node_modules/@anthropic-ai/claude-code-$arch ]; then
      ver=\$(node -p \"require('@anthropic-ai/claude-code/package.json').version\")
      npm install --no-save --ignore-scripts --legacy-peer-deps \
        @anthropic-ai/claude-code-$arch@\$ver
    fi
    # pack:headless rebuilds node-pty for THIS arch + bundles this arch's
    # claude + Node binary; everything else is copied from the shared tree.
    npm run pack:headless"
done

log "done — tarballs in release/headless/"
ls -1 "$REPO_ROOT"/release/headless/harness-server-*-linux-*.tar.gz 2>/dev/null || true
