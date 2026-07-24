#!/usr/bin/env bash
#
# Release script for Harness.
#
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.0.1
#
# Steps (all local edits, then a PR — no build, no publish happen
# inside this script; build runs in CI on the tag push at the end):
#   1. Preflight (clean tree, on main, gh authed, claude CLI present,
#      tag + release branch both available, merge method allowed)
#   2. Bump package.json + package-lock.json
#   3. Rewrite README download links
#   4. Generate site/public/releases.html entry via Claude
#   5. Write release-notes/v<ver>.md (read by the CI workflows)
#   6. Interactive confirm
#   7. Create release/v<ver> branch, commit "Release v<ver>", push it
#   8. Open PR against main with `gh pr create`
#   9. Watch PR checks until CI is green (`gh pr checks --watch`)
#  10. Merge PR — rebase by default, falling back to merge commit if
#      rebase is disabled. We never squash, so the "Release v<ver>"
#      subject is preserved on main and the prep commit stays
#      reachable.
#  11. Pull latest main, tag the new main HEAD (NOT the original prep
#      commit — its SHA changes during rebase-merge), push the tag.
#
# That tag push triggers .github/workflows/release.yml, which runs one
# `create-release` job (reading the body from release-notes/v<ver>.md
# committed in step 5) followed by three parallel build jobs
# (build-mac / build-linux / build-headless) that all depend on the
# create. dmg/zip/blockmap/latest-mac.yml + AppImage/deb/latest-linux.yml
# + harness-server tarballs all attach to the same release.
#
# Why a PR? main is protected by a ruleset that requires PRs + the
# `ci` status check. Direct pushes to main are rejected, so the
# version-bump commit has to land via a PR rather than a direct push.
#
# Recovery — the script is intentionally NOT idempotent across re-runs.
# If anything fails mid-flight, clean up by hand and start over with
# the same version. The script's trap handles the early windows
# automatically; the later ones print the exact cleanup commands.
#
#   * Before the commit lands locally — the trap restores edited files
#     automatically. No cleanup needed; just re-run.
#   * After the local commit but before the branch is pushed — the
#     trap returns you to main and deletes the local release branch.
#   * After the branch is pushed but before merge — close the PR (if
#     opened) and delete the branch on both sides:
#        gh pr close <pr-number> --delete-branch || true
#        git checkout main && git branch -D release/v<ver>
#        git push origin :release/v<ver>
#   * After merge but before the tag is pushed — the prep commit is
#     already on main. Tag main HEAD and push it manually:
#        git checkout main && git pull --ff-only origin main
#        git tag v<ver> && git push origin v<ver>
#
# Recovery if a build job fails after the tag push:
#   - Single job failed (e.g. flaky notarization)? Re-run that job from
#     the Actions UI. create-release is idempotent on re-run (detects
#     the existing release and skips), so a partial replay works.
#   - Whole release is bad? Delete the tag + release:
#        gh release delete v<ver> --cleanup-tag
#        git tag -d v<ver>
#      Fix the underlying issue, then re-run this script with the same
#      version. Re-pushing the tag fires release.yml fresh.

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

RELEASE_BRANCH="release/${TAG}"

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

# Release branch must not already exist locally or on remote. The
# script doesn't try to recover a partial run — if it failed mid-flight
# you need to delete the leftover branch by hand before retrying. See
# the recovery procedure in the header comment.
if git show-ref --verify --quiet "refs/heads/${RELEASE_BRANCH}"; then
  fail "Branch ${RELEASE_BRANCH} already exists locally. Delete it first: git branch -D ${RELEASE_BRANCH}"
fi
if git ls-remote --heads origin "refs/heads/${RELEASE_BRANCH}" | grep -q "${RELEASE_BRANCH}"; then
  fail "Branch ${RELEASE_BRANCH} already exists on origin. Delete it (and close any matching PR) first: git push origin :${RELEASE_BRANCH}"
fi
ok "Branch ${RELEASE_BRANCH} is available"

# Notarization creds used to live in .env and be checked here — they
# now live in GitHub Actions secrets (see .github/workflows/release.yml
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

# Pick the merge method we'll use for the PR. The repo's allowed-merge
# settings tell us which are enabled — we never squash (we want the
# "Release v<ver>" subject preserved on main with the prep commit
# reachable), so the choice is rebase or merge-commit. Default to
# rebase when enabled; if both are enabled the user gets a one-shot
# override at confirm time.
ALLOW_MERGE_COMMIT=$(gh repo view --json mergeCommitAllowed --jq '.mergeCommitAllowed')
ALLOW_REBASE_MERGE=$(gh repo view --json rebaseMergeAllowed --jq '.rebaseMergeAllowed')
if [ "$ALLOW_REBASE_MERGE" = "true" ]; then
  MERGE_METHOD="rebase"
elif [ "$ALLOW_MERGE_COMMIT" = "true" ]; then
  MERGE_METHOD="merge"
else
  fail "Repo has neither rebase nor merge-commit enabled — this script never squashes. Enable one in Settings → General → Pull Requests."
fi
ok "Merge method: ${MERGE_METHOD} (default)"

# Optional override when both methods are available
if [ "$ALLOW_REBASE_MERGE" = "true" ] && [ "$ALLOW_MERGE_COMMIT" = "true" ]; then
  echo
  read -r -p "Merge method [rebase/merge] (default: rebase): " method_choice
  case "$method_choice" in
    ""|rebase) MERGE_METHOD="rebase" ;;
    merge)     MERGE_METHOD="merge" ;;
    *)         fail "Invalid merge method '${method_choice}' (expected 'rebase' or 'merge')." ;;
  esac
fi

# Confirm before proceeding
echo
echo "${BOLD}Ready to prepare Harness v${VERSION}${RESET}"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo "  Branch: $RELEASE_BRANCH"
echo "  Merge:  $MERGE_METHOD"
echo
echo "This script will commit on a release branch, open a PR against"
echo "main, wait for CI to go green, merge, then tag the new main HEAD."
echo "Build/sign/notarize/upload all happen in CI after the tag push."
echo "Watch the workflows at:"
echo "  https://github.com/frenchie4111/harness/actions"
echo
read -r -p "Proceed? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# ---- Failure trap ----
# Window-by-window state machine. Each stage flips a flag so the trap
# knows what to undo (and what to leave alone for manual recovery).
#
#   STAGE=files     (default)
#     Edits made on main, nothing committed. Restore the touched files
#     + delete the new notes file so the tree is exactly as it
#     started.
#   STAGE=committed
#     Local commit on the release branch but not pushed. Check out
#     main and delete the local release branch — the commit is
#     unreachable but disk state is restored.
#   STAGE=pushed
#     Release branch is on origin (PR may or may not be open). Leave
#     the branch and print the manual cleanup commands; we don't want
#     to delete the PR / remote branch behind the user's back.
#   STAGE=merged
#     PR merged, prep commit is on main. Print instructions for
#     tagging main HEAD by hand — no rollback, the commit's good.
#   STAGE=tagged
#     Tag pushed. Trap is a no-op.
STAGE=files
RELEASE_NOTES_FILE="release-notes/${TAG}.md"
RELEASE_TOUCHED_FILES=(package.json package-lock.json README.md site/public/releases.html)
PR_NUMBER=""
recover_release() {
  local exit_code=$?
  if [ "$exit_code" = "0" ]; then
    return
  fi
  case "$STAGE" in
    files)
      echo
      warn "Release prep failed before commit — restoring working tree"
      git checkout -- "${RELEASE_TOUCHED_FILES[@]}" 2>/dev/null || true
      rm -f "$RELEASE_NOTES_FILE"
      # Tiny window: if we made it past `git checkout -b` but failed
      # before `git commit`, the empty release branch exists but has
      # no commit beyond main. Return to main and drop it. Safe
      # no-op when we never created the branch.
      if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$RELEASE_BRANCH" ]; then
        git checkout main 2>/dev/null || true
        git branch -D "${RELEASE_BRANCH}" 2>/dev/null || true
      fi
      ;;
    committed)
      echo
      warn "Release prep failed after local commit — returning to main and dropping ${RELEASE_BRANCH}"
      git checkout main 2>/dev/null || true
      git branch -D "${RELEASE_BRANCH}" 2>/dev/null || true
      ;;
    pushed)
      echo
      warn "Release prep failed after pushing ${RELEASE_BRANCH} — manual cleanup needed:"
      if [ -n "$PR_NUMBER" ]; then
        echo "    gh pr close ${PR_NUMBER} --delete-branch || true"
      else
        echo "    git push origin :${RELEASE_BRANCH}"
      fi
      echo "    git checkout main && git branch -D ${RELEASE_BRANCH}"
      ;;
    merged)
      echo
      warn "Merged ${RELEASE_BRANCH} into main but tag push failed — tag main HEAD by hand:"
      echo "    git checkout main && git pull --ff-only origin main"
      echo "    git tag ${TAG} && git push origin ${TAG}"
      ;;
    tagged)
      ;;
  esac
}
trap recover_release EXIT

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
# formatted "#NN @login". Used by the Claude releases.html prompt (for
# inline credits), the release-notes file (for the trailing Contributors
# section), and the PR body below (for an at-a-glance contributor list
# on the release PR itself).
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

# Snapshot the contributor list for the PR body before the temp file
# is removed at the end of release-notes generation below.
CONTRIBUTORS_PR_LIST=""
if [ -s "$CONTRIBUTORS_FILE" ]; then
  CONTRIBUTORS_PR_LIST=$(awk '{print "- " $1 " " $2}' "$CONTRIBUTORS_FILE" | sort -u)
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
# This file is committed alongside the version bump and read by
# release.yml's create-release job as the GitHub Release body. Keeping
# it as a committed file (rather than passing it through tag
# annotations or a workflow_dispatch input) keeps the workflow trivially
# simple — it just `--notes-file release-notes/${TAG}.md` — and gives
# us an audit trail of every release's notes inside the repo.
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

# ---- Create release branch and commit ----
step "Creating ${RELEASE_BRANCH} and committing release prep"
git checkout -b "$RELEASE_BRANCH"
git add package.json package-lock.json README.md site/public/releases.html "$RELEASE_NOTES_FILE"
git commit -m "Release v${VERSION}"
STAGE=committed
ok "Committed version bump, download links, releases.html entry, and release-notes file on ${RELEASE_BRANCH}"

# ---- Push branch ----
step "Pushing ${RELEASE_BRANCH} to origin"
git push -u origin "$RELEASE_BRANCH"
STAGE=pushed
ok "Pushed ${RELEASE_BRANCH}"

# ---- Open PR ----
# The body goes through a temp file + --body-file rather than a
# heredoc inside $(...): macOS system bash 3.2 (what env bash resolves
# to without a Homebrew bash) can't parse apostrophes inside a heredoc
# nested in command substitution — the script died with "unexpected
# EOF while looking for matching \`)'" the first time this ran for
# real. A plain `cat > file <<EOF` parses fine everywhere.
step "Opening pull request"
PR_BODY_FILE=$(mktemp)
cat > "$PR_BODY_FILE" <<EOF
Auto-generated by \`scripts/release.sh\` for Harness ${TAG}.

This PR contains the version bump, README link updates, \`site/public/releases.html\` entry, and \`release-notes/${TAG}.md\` for the release. Once CI passes and this PR is merged, the script will tag the new \`main\` HEAD as \`${TAG}\`. The tag push then fires [\`release.yml\`](https://github.com/frenchie4111/harness/blob/main/.github/workflows/release.yml), which builds, signs, notarizes, and uploads artifacts to the GitHub release.

The script is blocking on \`gh pr checks ${RELEASE_BRANCH} --watch\` and will merge automatically when CI is green — don't close or merge this PR by hand unless aborting the release.
EOF
if [ -n "$CONTRIBUTORS_PR_LIST" ]; then
  cat >> "$PR_BODY_FILE" <<EOF

### Contributors

${CONTRIBUTORS_PR_LIST}
EOF
fi
PR_URL=$(gh pr create --base main --head "$RELEASE_BRANCH" --title "Release ${TAG}" --body-file "$PR_BODY_FILE")
rm -f "$PR_BODY_FILE"
PR_NUMBER=$(printf '%s' "$PR_URL" | awk -F/ '{print $NF}')
ok "Opened PR #${PR_NUMBER}: $PR_URL"

# ---- Wait for CI ----
# `gh pr checks --watch` blocks until every required check completes
# and exits non-zero if any failed. If it fails, the trap prints the
# manual cleanup commands and exits — the user can push fixes to the
# branch and finish by hand, or close the PR and start over.
step "Waiting for CI on PR #${PR_NUMBER}"
echo "  (gh pr checks ${PR_NUMBER} --watch — Ctrl-C to abort)"
gh pr checks "$PR_NUMBER" --watch
ok "CI passed"

# ---- Merge ----
step "Merging PR #${PR_NUMBER} with --${MERGE_METHOD}"
gh pr merge "$PR_NUMBER" "--${MERGE_METHOD}" --delete-branch
STAGE=merged
ok "Merged"

# ---- Pull main, tag, push ----
# Tag main HEAD, not the local prep commit — rebase-merge rewrites the
# SHA so the original commit's hash is no longer on any branch.
step "Tagging new main HEAD"
git checkout main
git pull --ff-only origin main
git tag "$TAG"
git push origin "$TAG"
STAGE=tagged
ok "Pushed ${TAG} (now $(git rev-parse --short "$TAG"))"

step "Done — release.yml is now building"
echo "  Watch the workflow at:"
echo "    https://github.com/frenchie4111/harness/actions/workflows/release.yml"
echo "  The GitHub release will appear at:"
echo "    https://github.com/frenchie4111/harness/releases/tag/${TAG}"
