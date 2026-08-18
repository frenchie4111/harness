#!/usr/bin/env bash
#
# Regenerate every raster icon in the repo from resources/icon.svg.
#
#   bash scripts/build-icons.sh
#
# Outputs:
#   resources/icon.png           1024  electron-builder source (mac/win/linux)
#   resources/icon-original.png  512   the pre-resize original kept alongside it
#   resources/icon.icns                macOS bundle icon, built via iconutil
#   site/public/icon.png         512   site favicon + PWA icon
#   site/public/apple-touch-icon.png 180
#
# Requires rsvg-convert (brew install librsvg) and iconutil (macOS built-in).
# This script does NOT touch electron-builder config — it only rewrites the
# files that config already points at.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=resources/icon.svg

for bin in rsvg-convert iconutil; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 1; }
done

png() { rsvg-convert -w "$2" -h "$2" "$SRC" -o "$1"; echo "  $1  ${2}x${2}"; }

echo "app icons"
png resources/icon.png 1024
png resources/icon-original.png 512

echo "icns"
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  png "$ICONSET/icon_${s}x${s}.png" $s
  png "$ICONSET/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$ICONSET" -o resources/icon.icns
rm -rf "$(dirname "$ICONSET")"
echo "  resources/icon.icns"

echo "site icons"
png site/public/icon.png 512
png site/public/apple-touch-icon.png 180

echo "done"
