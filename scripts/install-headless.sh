#!/bin/sh
# Installer for harness-server: detects platform, downloads the right
# tarball + sha256 from a GitHub Release, verifies, extracts atomically
# to ~/.harness-server, and (if writable) drops a /usr/local/bin/ symlink.
#
# Override the source with environment variables:
#   HARNESS_SERVER_VERSION  pinned version tag (default: latest)
#   HARNESS_SERVER_BASE_URL base URL serving the tarball + .sha256
#                           (default: GitHub releases for frenchie4111/harness)
#   HARNESS_SERVER_TARBALL  absolute path to a tarball ALREADY staged on this
#                           machine (e.g. uploaded over SSH by the Harness app).
#                           When set, the GitHub download + version resolution
#                           are skipped entirely and this file is installed
#                           directly. If a sibling "<tarball>.sha256" exists (or
#                           HARNESS_SERVER_SHA256 is set) it is verified.
#
# POSIX-only — runs under dash, ash, busybox sh in addition to bash/zsh.

set -eu

OWNER="frenchie4111"
REPO="harness"
INSTALL_DIR="${HARNESS_SERVER_INSTALL_DIR:-$HOME/.harness-server}"
TMP_DIR="$INSTALL_DIR.tmp"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

# --- platform detection ---
uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) err "unsupported OS: $uname_s (this installer supports macOS and Linux only)" ;;
esac

case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) err "unsupported architecture: $uname_m" ;;
esac

PLATFORM="$os-$arch"

# Intel Macs are not currently shipped — GitHub's macos-13 runner
# queue is too unreliable. Apple Silicon is the only macOS target.
if [ "$PLATFORM" = "darwin-x64" ]; then
  err "darwin-x64 (Intel Mac) tarballs are not currently shipped. Run on Apple Silicon, or build from source."
fi

# --- pick a sha256 tool (needed in both download + local-tarball modes) ---
if command -v shasum >/dev/null 2>&1; then
  sha256_cmd="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_cmd="sha256sum"
else
  err "neither shasum nor sha256sum is available"
fi

LOCAL_TARBALL="${HARNESS_SERVER_TARBALL:-}"
DL_DIR=$(mktemp -d)
# Best effort cleanup; if the script blows up the OS reaps /tmp eventually.
trap 'rm -rf "$DL_DIR"' EXIT

if [ -n "$LOCAL_TARBALL" ]; then
  # --- local-tarball mode: the Harness app already staged the bytes here ---
  [ -f "$LOCAL_TARBALL" ] || err "HARNESS_SERVER_TARBALL not found: $LOCAL_TARBALL"
  TARBALL_FILE="$LOCAL_TARBALL"
  log "installing from staged tarball $LOCAL_TARBALL"
  # Verify if we were handed (or can find) a checksum; otherwise the bytes
  # came straight off the local machine over an authenticated channel, so a
  # missing checksum is a warning, not a hard error.
  EXPECTED="${HARNESS_SERVER_SHA256:-}"
  if [ -z "$EXPECTED" ] && [ -f "$LOCAL_TARBALL.sha256" ]; then
    EXPECTED=$(awk '{print $1}' "$LOCAL_TARBALL.sha256")
  fi
  if [ -n "$EXPECTED" ]; then
    log "verifying checksum..."
    ACTUAL=$($sha256_cmd "$TARBALL_FILE" | awk '{print $1}')
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      err "sha256 mismatch: expected $EXPECTED, got $ACTUAL"
    fi
  else
    log "no checksum provided for staged tarball — skipping verification"
  fi
else
  # --- download mode: pull the tarball from a GitHub release ---
  VERSION="${HARNESS_SERVER_VERSION:-latest}"
  if [ "$VERSION" = "latest" ]; then
    log "resolving latest harness-server release..."
    if command -v curl >/dev/null 2>&1; then
      LATEST_JSON=$(curl -fsSL "https://api.github.com/repos/$OWNER/$REPO/releases/latest")
    else
      err "curl is required but not installed"
    fi
    # Parse "tag_name": "v1.2.3" without jq.
    VERSION=$(printf '%s\n' "$LATEST_JSON" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
    if [ -z "$VERSION" ]; then
      err "could not parse latest version from GitHub API response"
    fi
  fi
  # Strip a leading 'v' if the user passed one.
  VERSION="${VERSION#v}"

  TARBALL="harness-server-$VERSION-$PLATFORM.tar.gz"
  DEFAULT_BASE="https://github.com/$OWNER/$REPO/releases/download/v$VERSION"
  BASE_URL="${HARNESS_SERVER_BASE_URL:-$DEFAULT_BASE}"
  URL="$BASE_URL/$TARBALL"
  SHA_URL="$URL.sha256"

  log "downloading $URL"
  if ! curl -fsSL --output "$DL_DIR/$TARBALL" "$URL"; then
    err "download failed: $URL"
  fi
  log "downloading $SHA_URL"
  if ! curl -fsSL --output "$DL_DIR/$TARBALL.sha256" "$SHA_URL"; then
    err "checksum download failed: $SHA_URL"
  fi

  log "verifying checksum..."
  EXPECTED=$(awk '{print $1}' "$DL_DIR/$TARBALL.sha256")
  ACTUAL=$($sha256_cmd "$DL_DIR/$TARBALL" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    err "sha256 mismatch: expected $EXPECTED, got $ACTUAL"
  fi
  TARBALL_FILE="$DL_DIR/$TARBALL"
fi

# --- extract atomically ---
log "extracting to $INSTALL_DIR"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
tar -xzf "$TARBALL_FILE" -C "$TMP_DIR"
# The tarball's sole top-level dir is harness-server-<version>-<platform>/;
# flatten it so $INSTALL_DIR/bin/harness-server is the canonical path
# regardless of version. We locate it generically (the single child dir)
# rather than reconstructing the name, so local-tarball mode doesn't need to
# know the version baked into the archive.
EXTRACTED=""
for d in "$TMP_DIR"/*/; do
  [ -d "$d" ] || continue
  if [ -n "$EXTRACTED" ]; then
    err "tarball contained more than one top-level directory"
  fi
  EXTRACTED="${d%/}"
done
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  err "tarball did not contain a top-level harness-server directory"
fi
rm -rf "$INSTALL_DIR"
mv "$EXTRACTED" "$INSTALL_DIR"
rm -rf "$TMP_DIR"

BIN="$INSTALL_DIR/bin/harness-server"
if [ ! -x "$BIN" ]; then
  err "harness-server binary not at expected path: $BIN"
fi

# --- /usr/local/bin symlink (best effort) ---
SYMLINK="/usr/local/bin/harness-server"
if [ -w /usr/local/bin ] || ([ ! -e /usr/local/bin ] && [ -w /usr/local ]); then
  ln -sf "$BIN" "$SYMLINK"
  log "symlinked $SYMLINK → $BIN"
else
  log ""
  log "/usr/local/bin is not writable. Add this to your shell profile:"
  log ""
  log "  export PATH=\"\$HOME/.harness-server/bin:\$PATH\""
  log ""
fi

# --- smoke test ---
INSTALLED_VERSION=$("$BIN" --version 2>/dev/null || echo "?")
log "harness-server $INSTALLED_VERSION installed at $INSTALL_DIR"
log "run: harness-server --port 0"
