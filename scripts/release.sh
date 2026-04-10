#!/usr/bin/env bash
#
# Release script for Harness.
#
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.0.1
#
# Steps:
#   1. Validate version arg, clean working tree, on main, env file present
#   2. Bump package.json version, commit
#   3. Build + sign + notarize for macOS (npm run dist:mac)
#   4. Tag and push
#   5. Generate release notes from commits since last tag
#   6. Create GitHub release with all artifacts attached

set -euo pipefail

# ---- Args ----
if [ $# -lt 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.0.1"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

# Strip leading v if present
if [[ "$VERSION" =~ ^v ]]; then
  VERSION="${VERSION#v}"
  TAG="v${VERSION}"
fi

# ---- Pretty output ----
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

step() { echo -e "\n${BLUE}${BOLD}==>${RESET} ${BOLD}$1${RESET}"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "${RED}✗${RESET} $1" >&2; exit 1; }

# ---- Move to repo root ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}/.."

# ---- Preflight ----
step "Preflight checks"

# Working tree must be clean
if [ -n "$(git status --porcelain)" ]; then
  fail "Working tree is not clean. Commit or stash changes first."
fi
ok "Working tree clean"

# Must be on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  fail "Not on main branch (currently on '$BRANCH')."
fi
ok "On main branch"

# Tag must not already exist locally or on remote
if git rev-parse "$TAG" >/dev/null 2>&1; then
  fail "Tag $TAG already exists locally. Delete it first if you want to retry: git tag -d $TAG"
fi
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  fail "Tag $TAG already exists on origin. Delete it first if you want to retry: git push origin :refs/tags/$TAG"
fi
ok "Tag $TAG is available"

# .env must exist with notarization creds
if [ ! -f .env ]; then
  fail ".env file is missing — needed for notarization"
fi
if ! grep -q "^APPLE_ID=." .env || ! grep -q "^APPLE_APP_SPECIFIC_PASSWORD=" .env || ! grep -q "^APPLE_TEAM_ID=." .env; then
  fail ".env is missing one or more required vars: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID"
fi
ok ".env has notarization credentials"

# gh CLI must be authenticated
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI is not installed. Install with: brew install gh"
fi
if ! gh auth status >/dev/null 2>&1; then
  fail "gh CLI is not authenticated. Run: gh auth login"
fi
ok "gh CLI is authenticated"

# Confirm before proceeding
echo
echo "${BOLD}Ready to release Harness v${VERSION}${RESET}"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo
read -r -p "Proceed? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# ---- Bump version ----
step "Bumping package.json to ${VERSION}"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.version = '${VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
ok "package.json updated"

# ---- Update README and landing page download links ----
step "Updating download links in README and docs/index.html"
node -e "
const fs = require('fs');
const v = '${VERSION}';
const files = ['README.md', 'docs/index.html'];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let content = fs.readFileSync(f, 'utf-8');
  // Replace any X.Y.Z in Harness-X.Y.Z (filename) or download/vX.Y.Z (path)
  content = content.replace(/Harness-\d+\.\d+\.\d+/g, \`Harness-\${v}\`);
  content = content.replace(/releases\/download\/v\d+\.\d+\.\d+/g, \`releases/download/v\${v}\`);
  fs.writeFileSync(f, content);
}
"
ok "Download links updated"

git add package.json README.md docs/index.html
git commit -m "Release v${VERSION}"
ok "Committed version bump and download link updates"

# ---- Build / sign / notarize ----
step "Building, signing, and notarizing (this takes several minutes)"
rm -rf release
npm run dist:mac
ok "Build complete"

# Sanity check the artifacts exist
DMG_ARM64="release/Harness-${VERSION}-arm64.dmg"
DMG_X64="release/Harness-${VERSION}.dmg"
ZIP_ARM64="release/Harness-${VERSION}-arm64-mac.zip"
ZIP_X64="release/Harness-${VERSION}-mac.zip"
LATEST_YML="release/latest-mac.yml"

for f in "$DMG_ARM64" "$DMG_X64" "$ZIP_ARM64" "$ZIP_X64" "$LATEST_YML"; do
  if [ ! -f "$f" ]; then
    fail "Missing build artifact: $f"
  fi
done
ok "All artifacts present"

# ---- Tag and push ----
step "Tagging and pushing"
git tag "$TAG"
git push origin main
git push origin "$TAG"
ok "Pushed main and $TAG"

# ---- Generate release notes ----
step "Generating release notes"
PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
if [ -z "$PREV_TAG" ]; then
  warn "No previous tag found, using full history"
  CHANGES=$(git log --pretty=format:'- %s' "$TAG")
else
  echo "Comparing $PREV_TAG..$TAG"
  CHANGES=$(git log --pretty=format:'- %s' "${PREV_TAG}..${TAG}" | grep -v "^- Co-Authored-By:" || true)
fi

NOTES_FILE=$(mktemp)
cat > "$NOTES_FILE" <<EOF
## Harness ${TAG}

### Changes
${CHANGES}

### Installing

- **Apple Silicon:** \`Harness-${VERSION}-arm64.dmg\`
- **Intel:** \`Harness-${VERSION}.dmg\`

Drag \`Harness.app\` to Applications, then launch it. Existing installs will auto-update.
EOF

ok "Release notes generated"

# ---- Create GitHub release ----
step "Creating GitHub release"
gh release create "$TAG" \
  "$DMG_ARM64" \
  "$DMG_X64" \
  "$ZIP_ARM64" \
  "$ZIP_X64" \
  "$LATEST_YML" \
  release/Harness-${VERSION}-arm64.dmg.blockmap \
  release/Harness-${VERSION}.dmg.blockmap \
  release/Harness-${VERSION}-arm64-mac.zip.blockmap \
  release/Harness-${VERSION}-mac.zip.blockmap \
  --title "Harness ${TAG}" \
  --notes-file "$NOTES_FILE"

rm -f "$NOTES_FILE"

step "Done"
RELEASE_URL=$(gh release view "$TAG" --json url --jq .url)
ok "Released ${TAG}"
echo "  ${RELEASE_URL}"
