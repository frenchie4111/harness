#!/usr/bin/env bash
#
# Release script for Harness.
#
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.0.1
#
# Steps (all local — no build, no publish):
#   1. Preflight (clean tree, on main, gh authed, claude CLI present)
#   2. Bump package.json + package-lock.json
#   3. Rewrite README download links
#   4. Generate site/public/releases.html entry via Claude
#   5. Write release-notes/v<ver>.md (read by the CI workflows)
#   6. Interactive confirm
#   7. Commit "Release v<ver>", tag, push main + tag
#
# That tag push fans out to three parallel GitHub Actions workflows:
#   - .github/workflows/build-mac.yml      → dmg / zip / blockmap / latest-mac.yml
#   - .github/workflows/build-linux.yml    → AppImage / deb / latest-linux.yml
#   - .github/workflows/headless-release.yml → harness-server tarballs
#
# All three workflows are idempotent on the release (any can create it;
# the rest upload-with-clobber), and all three read the release body
# from release-notes/v<ver>.md committed in step 5.
#
# Recovery if a workflow fails after tag push:
#   1. Fix the workflow / secret / build issue on a branch.
#   2. Delete the tag locally + on origin:
#        git tag -d v<ver>
#        git push origin :refs/tags/v<ver>
#      (Optionally `gh release delete v<ver>` if a partial release was
#      created before the failure.)
#   3. Land the fix on main, then re-run this script with the same
#      version. The workflows are idempotent on tag — re-pushing the
#      same tag retriggers all three.

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

# Notarization creds used to live in .env and be checked here — they
# now live in GitHub Actions secrets (see .github/workflows/build-mac.yml
# header for the list). No local .env check anymore.

# gh CLI must be authenticated
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI is not installed. Install with: brew install gh"
fi
if ! gh auth status >/dev/null 2>&1; then
  fail "gh CLI is not authenticated. Run: gh auth login"
fi
ok "gh CLI is authenticated"

# gh needs a default repo set so the contributor lookup below resolves
# PR numbers correctly.
if ! gh repo set-default --view >/dev/null 2>&1; then
  fail "gh has no default repo for this directory. Run: gh repo set-default frenchie4111/harness"
fi
ok "gh default repo is set"

# claude CLI must be available (used for release notes generation)
if ! command -v claude >/dev/null 2>&1; then
  fail "claude CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code"
fi
ok "claude CLI is available"

# Confirm before proceeding
echo
echo "${BOLD}Ready to prepare Harness v${VERSION}${RESET}"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo
echo "This script will commit + push the tag. Build/sign/notarize/upload"
echo "all happen in CI after the tag push. Watch the workflows at:"
echo "  https://github.com/frenchie4111/harness/actions"
echo
read -r -p "Proceed? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# ---- Failure trap ----
# All file edits (version bump, README, releases.html, release-notes
# file) happen up front but the commit is deferred to the end. If we
# exit non-zero before committing, restore the touched files + delete
# the new notes file so a failed prepare leaves the tree exactly as it
# started — no half-prepared "Release v..." commit sitting on main.
#
# Once COMMITTED=1 the trap becomes a no-op. If `git push` then fails
# after a successful commit, the user recovers by `git reset --hard
# origin/main` and re-running. If the tag push fails after main pushed,
# they recover with `git push origin $TAG`. If CI fails after both
# pushed, see the recovery procedure in the header comment.
COMMITTED=0
RELEASE_NOTES_FILE="release-notes/${TAG}.md"
RELEASE_TOUCHED_FILES=(package.json package-lock.json README.md site/public/releases.html)
restore_release_files() {
  local exit_code=$?
  if [ "$COMMITTED" = "0" ] && [ "$exit_code" != "0" ]; then
    echo
    warn "Release prep failed before commit — restoring working tree"
    git checkout -- "${RELEASE_TOUCHED_FILES[@]}" 2>/dev/null || true
    rm -f "$RELEASE_NOTES_FILE"
  fi
}
trap restore_release_files EXIT

# ---- Bump version ----
step "Bumping package.json and package-lock.json to ${VERSION}"
node -e "
const fs = require('fs');
const v = '${VERSION}';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.version = v;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf-8'));
  lock.version = v;
  if (lock.packages && lock.packages['']) lock.packages[''].version = v;
  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}
"
ok "package.json and package-lock.json updated"

# ---- Update README download links ----
# The marketing-site Install page reads version from package.json at build
# time, so it no longer needs in-HTML regex replacement. README still
# carries hard-coded DMG URLs that we keep in sync here.
step "Updating download links in README"
node -e "
const fs = require('fs');
const v = '${VERSION}';
const files = ['README.md'];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let content = fs.readFileSync(f, 'utf-8');
  content = content.replace(/Harness-\d+\.\d+\.\d+/g, \`Harness-\${v}\`);
  content = content.replace(/releases\/download\/v\d+\.\d+\.\d+/g, \`releases/download/v\${v}\`);
  fs.writeFileSync(f, content);
}
"
ok "Download links updated"

# ---- Build contributors map ----
# One line per PR authored by someone other than the release maintainer,
# formatted "#NN @login". Used by both the Claude releases.html prompt
# (for inline credits) and the release-notes file (for the trailing
# Contributors section).
PREV_TAG=$(git describe --tags --abbrev=0 HEAD 2>/dev/null || true)
CONTRIBUTORS_FILE=$(mktemp)
SELF_USER=$(gh api user --jq .login 2>/dev/null || echo "")
if [ -n "$PREV_TAG" ]; then
  for pr_num in $(git log --pretty=format:'%s' "${PREV_TAG}..HEAD" | grep -oE '#[0-9]+' | tr -d '#' | sort -u); do
    pr_author=$(gh pr view "$pr_num" --json author --jq '.author.login' 2>/dev/null || true)
    if [ -n "$pr_author" ] && [ "$pr_author" != "$SELF_USER" ]; then
      echo "#${pr_num} @${pr_author}" >> "$CONTRIBUTORS_FILE"
    fi
  done
fi
if [ -s "$CONTRIBUTORS_FILE" ]; then
  ok "External contributors: $(awk '{print $2}' "$CONTRIBUTORS_FILE" | sort -u | paste -sd ' ' -)"
else
  echo "  (no external contributors this release)"
fi

# ---- Generate release notes for site/public/releases.html ----
step "Generating release notes with Claude"
if [ -z "$PREV_TAG" ]; then
  CHANGES=$(git log --pretty=format:'- %s' HEAD)
else
  CHANGES=$(git log --pretty=format:'- %s' "${PREV_TAG}..HEAD" | grep -v "^- Co-Authored-By:" | grep -v "^- Release v" || true)
fi

CHANGES_FILE=$(mktemp)
echo "$CHANGES" > "$CHANGES_FILE"

RELEASE_DATE=$(date +"%B %-d, %Y")

claude -p "Add a release entry for ${TAG} (released ${RELEASE_DATE}) to site/public/releases.html.

The raw commit messages since the last release are in ${CHANGES_FILE} — read that file.

External contributors for this release are in ${CONTRIBUTORS_FILE} — read that file too. Each line is '#NN @login' for a PR authored by someone other than the release maintainer. If the file is empty or missing, there are no external contributors and you should skip the credit instructions below.

Read site/public/releases.html to understand the existing HTML structure and writing style,
then insert the new entry at the top of the releases list (right after the <!-- Releases -->
div opening, before the first existing release section). See the v2.9.3 entry for the canonical inline-credit and trailing-thanks pattern.

Rules:
- Match the exact HTML structure, CSS classes, and formatting of existing entries.
- The new <section class=\"release-section py-10\"> MUST include id=\"${TAG}\" (e.g. id=\"v1.2.3\") so it can be deep-linked from the in-app updater UI.
- The version <h2> MUST wrap its text in a self-link matching existing entries, e.g.: <h2 class=\"text-3xl font-bold tracking-tight\"><a href=\"#${TAG}\" class=\"release-anchor\">${TAG}<span class=\"anchor-icon\">🔗</span></a></h2>
- Rewrite commit messages into user-facing release notes. Write for users, not developers.
- Group under h4 headings: \"New features\", \"Improvements\", \"Fixes\" — only include sections that have content.
- Skip meta commits: version bumps, README updates, CI fixes, squash labels.
- A short 1-2 sentence headline summary in the <p> tag after the download link.
- Date format: \"${RELEASE_DATE}\".
- Download link points to: https://github.com/frenchie4111/harness/releases/tag/${TAG}
- For any <li> whose change corresponds to a PR listed in the contributors file, append an inline credit at the end of the <li>: <em class=\"text-neutral-500\">(thanks <a href=\"https://github.com/LOGIN\" class=\"text-amber-400/80 hover:text-amber-300\">@LOGIN</a>, <a href=\"https://github.com/frenchie4111/harness/pull/NN\" class=\"text-amber-400/80 hover:text-amber-300\">#NN</a>)</em>. Match #NN to the PR number embedded in the original commit message.
- If the contributors file has any entries, end the .note-body div with a trailing <p class=\"text-neutral-400 text-sm mt-6 leading-relaxed\"> that reads 'Huge thanks to @user1, @user2, and @userN for their contributions to this release.' — each @user wrapped in <a href=\"https://github.com/LOGIN\" class=\"text-amber-400/80 hover:text-amber-300\">@LOGIN</a>, ordered alphabetically, with Oxford-comma 'and' formatting.
- Do NOT modify any existing release entries. Only add the new one." \
  --allowedTools Read,Edit --model sonnet \
  || warn "Claude failed to update release notes — continuing anyway"

rm -f "$CHANGES_FILE"

if ! git diff --quiet site/public/releases.html 2>/dev/null; then
  ok "Release notes page updated"
else
  warn "Claude did not modify site/public/releases.html — continuing anyway"
fi

# ---- Write release-notes/v<ver>.md ----
# This file is committed alongside the version bump and read by all
# three CI workflows (build-mac.yml, build-linux.yml,
# headless-release.yml) as the GitHub Release body. Keeping it as a
# committed file (rather than passing it through tag annotations or a
# workflow_dispatch input) keeps the workflows trivially simple — they
# just `--notes-file release-notes/${TAG}.md` — and gives us an audit
# trail of every release's notes inside the repo.
step "Writing ${RELEASE_NOTES_FILE}"
mkdir -p release-notes

CONTRIBUTORS_SECTION=""
if [ -s "$CONTRIBUTORS_FILE" ]; then
  USERS_FORMATTED=$(awk '{print $2}' "$CONTRIBUTORS_FILE" | sort -u | awk '
    { users[NR] = $0 }
    END {
      if (NR == 1) print users[1]
      else if (NR == 2) print users[1] " and " users[2]
      else {
        out = ""
        for (i = 1; i < NR; i++) out = out users[i] ", "
        print out "and " users[NR]
      }
    }
  ')
  CONTRIBUTORS_SECTION=$(printf '\n### Contributors\n\nHuge thanks to %s for their contributions to this release.\n' "$USERS_FORMATTED")
fi

cat > "$RELEASE_NOTES_FILE" <<EOF
## Harness ${TAG}

### Changes
${CHANGES}${CONTRIBUTORS_SECTION}

### Installing

- **Apple Silicon:** \`Harness-${VERSION}-arm64.dmg\`
- **Intel:** \`Harness-${VERSION}.dmg\`

Drag \`Harness.app\` to Applications, then launch it. Existing installs will auto-update.
EOF

rm -f "$CONTRIBUTORS_FILE"
ok "Release notes written to ${RELEASE_NOTES_FILE}"

# ---- Commit version bump + release notes ----
step "Committing release prep"
git add package.json package-lock.json README.md site/public/releases.html "$RELEASE_NOTES_FILE"
git commit -m "Release v${VERSION}"
COMMITTED=1
ok "Committed version bump, download links, releases.html entry, and release-notes file"

# ---- Tag and push ----
# After this point the CI workflows take over. If any of them fail, see
# the recovery procedure in the header comment.
step "Tagging and pushing"
git tag "$TAG"
git push origin main
git push origin "$TAG"
ok "Pushed main and $TAG"

step "Done — CI is now building"
echo "  Watch the workflows at:"
echo "    https://github.com/frenchie4111/harness/actions"
echo "  The GitHub release will appear at:"
echo "    https://github.com/frenchie4111/harness/releases/tag/${TAG}"
echo "  (created by whichever of build-mac / build-linux / headless-release"
echo "   wins the race; the rest upload-with-clobber.)"
