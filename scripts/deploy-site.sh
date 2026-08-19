#!/usr/bin/env bash
#
# Deploy the Ness marketing site (site/) to Vercel.
#
# Usage: ./scripts/deploy-site.sh [--prod] [--skip-build] [--skip-verify]
# Example: ./scripts/deploy-site.sh --prod
#
# Steps:
#   1. Scope guard — assert we are deploying to the mike-personal team
#      and the `ness` project, and nothing else (see "Scope safety").
#   2. Link the repo to mike-personal/ness if .vercel/project.json is
#      missing (skipped in CI, which supplies the IDs via env).
#   3. `npm run build:site` → site/dist
#   4. Assemble a Build Output API v3 payload at .vercel/output
#   5. `vercel deploy --prebuilt` (preview, or production with --prod)
#   6. Verify the shipped URL paths still resolve (see "URL paths")
#
# --- Why prebuilt, not a source push -------------------------------
#
# We deliberately do NOT let Vercel run the build. The root
# package.json pulls in Electron plus the bundled
# @anthropic-ai/claude-code platform binary — several hundred MB of
# native artifacts that a static marketing site has no use for — and
# needs --legacy-peer-deps to install at all. Building on Vercel means
# paying that cost on every deploy.
#
# Instead we build here and ship the finished files via the Build
# Output API (v3): .vercel/output/static holds the site, and
# .vercel/output/config.json is the minimal {"version":3}. Vercel does
# zero work beyond serving the upload.
#
# This is also why the repo has no Vercel Git integration — pushes to
# GitHub do not themselves trigger a Vercel build. .github/workflows/
# deploy-site.yml is what calls this script on pushes to main.
#
# One trap that follows from having no Git integration: a bare
# `vercel deploy` is NOT a preview. For projects without a connected
# repo the CLI defaults to the production target and moves the
# production alias. Step 5 therefore always passes an explicit
# --target=preview / --target=production and never relies on the
# default.
#
# --- Scope safety ---------------------------------------------------
#
# The account this deploys from also has access to the user's employer
# team (hi-finance). A deploy landing there would be a real incident,
# so the target is pinned three ways and none of them is a comment
# asking someone to remember:
#
#   * Every vercel invocation passes an explicit --scope. The CLI's
#     implicit default scope is whatever `vercel switch` last set and
#     is NOT trusted here.
#   * EXPECTED_ORG_ID / EXPECTED_PROJECT_ID below are the real IDs of
#     mike-personal/ness. If .vercel/project.json (local) or
#     VERCEL_ORG_ID / VERCEL_PROJECT_ID (CI) disagree with them, the
#     script aborts before touching the network.
#   * The assertion runs again after linking, so a link that silently
#     resolved to another team is caught rather than deployed.
#
# If the project is ever legitimately recreated, update the two ID
# constants — do not relax the check.
#
# --- URL paths must not change --------------------------------------
#
# Shipped clients hardcode paths into this site.
# src/main/announcements-poller.ts polls /announcements.json, and the
# entries in that feed link at /announcements/<slug>.html. Those exact
# paths are baked into every already-installed copy of the app, so a
# hosting change that rewrites them breaks clients in the field.
#
# Concretely: do NOT enable cleanUrls (it would redirect /foo.html to
# /foo), do NOT set trailingSlash, and do not add routes that rewrite
# .html paths. config.json stays {"version":3} for that reason. Step 6
# re-checks the live deployment for each critical path and fails the
# script if any of them stops resolving.
#
# --- Recovery -------------------------------------------------------
#
# The script is idempotent — it rebuilds site/dist and rewrites
# .vercel/output from scratch on every run, so a failed run is fixed by
# fixing the cause and running it again. Nothing needs unwinding.
#
# Two failures worth naming:
#
#   * Every path reports "gated by Deployment Protection" — the deploy
#     succeeded, but the URL is behind Vercel's SSO redirect. Under the
#     default Standard Protection the production alias is public while
#     preview URLs are gated, so this is the normal outcome for an
#     unauthenticated preview check. Either set
#     VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment
#     Protection → Protection Bypass for Automation) or open the
#     printed URL in a logged-in browser.
#   * `vercel link` fails or picks the wrong team — delete .vercel/ and
#     re-run. The IDs are re-asserted after every link.
#
set -euo pipefail

# --- Pinned target. Do not make these configurable. ---
VERCEL_SCOPE="mike-personal"
VERCEL_PROJECT_NAME="ness"
EXPECTED_ORG_ID="team_WPsnEYquqTM2pNOKRhusfIbg"
EXPECTED_PROJECT_ID="prj_2OW4xWxb0i2khtSCDAKIoixk8khA"

# Paths that shipped clients depend on. "json" entries are additionally
# parsed, because a 200 that serves an HTML error page is still a break.
CRITICAL_PATHS=(
  "/announcements.json|json"
  "/announcements/ness-rename.html|html"
  "/announcements.html|html"
  "/guide.html|html"
  "/releases.html|html"
  "/|html"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERCEL_BIN="${VERCEL_BIN:-vercel}"

PROD=0
SKIP_BUILD=0
SKIP_VERIFY=0

for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help)
      echo "usage: $0 [--prod] [--skip-build] [--skip-verify]"
      echo "Deploys site/ to $VERCEL_SCOPE/$VERCEL_PROJECT_NAME on Vercel as a prebuilt upload."
      echo "See the header comment in this file for the full flow."
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: $0 [--prod] [--skip-build] [--skip-verify]" >&2
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# vercel reads VERCEL_TOKEN from the environment on its own, but we pass
# it explicitly so an unset token fails as an auth error rather than
# silently falling back to whatever local session exists.
# Named vercel_cli rather than vercel so `command -v` below still probes
# the real binary instead of resolving to this function.
vercel_cli() {
  local args=("$@" --scope "$VERCEL_SCOPE")
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    args+=(--token "$VERCEL_TOKEN")
  fi
  "$VERCEL_BIN" "${args[@]}"
}

# --- 1. Scope guard --------------------------------------------------

step "Checking deploy target"

command -v "$VERCEL_BIN" >/dev/null 2>&1 \
  || die "vercel CLI not found (looked for '$VERCEL_BIN'). Install it with 'npm i -g vercel', or set VERCEL_BIN to its path."

# CI supplies the IDs via env instead of .vercel/project.json. Check them
# before anything else so a mis-set secret can't reach the network.
if [[ -n "${VERCEL_ORG_ID:-}" && "$VERCEL_ORG_ID" != "$EXPECTED_ORG_ID" ]]; then
  die "VERCEL_ORG_ID is '$VERCEL_ORG_ID' but this script only deploys to '$VERCEL_SCOPE' ($EXPECTED_ORG_ID). Refusing to continue."
fi
if [[ -n "${VERCEL_PROJECT_ID:-}" && "$VERCEL_PROJECT_ID" != "$EXPECTED_PROJECT_ID" ]]; then
  die "VERCEL_PROJECT_ID is '$VERCEL_PROJECT_ID' but this script only deploys to project '$VERCEL_PROJECT_NAME' ($EXPECTED_PROJECT_ID). Refusing to continue."
fi

# Prove the credentials work before building. Without this the first
# real API call is `vercel deploy`, so a bad VERCEL_TOKEN surfaces two
# minutes into the job as "Not able to load user because of unexpected
# error: User not found. (404)" — which reads like a Vercel outage
# rather than a bad secret. Failing here instead costs one API call and
# names the actual cause.
step "Checking credentials"

if ! WHOAMI=$(vercel_cli whoami 2>&1); then
  printf '%s\n' "$WHOAMI" >&2
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    die "the vercel CLI rejected VERCEL_TOKEN (see above). Check the token at https://vercel.com/account/tokens — it must be valid, unexpired, and scoped to the '$VERCEL_SCOPE' team. Verify it locally with: vercel whoami --scope $VERCEL_SCOPE --token <token>"
  fi
  die "not authenticated to Vercel (see above). Run 'vercel login', or set VERCEL_TOKEN."
fi

echo "Authenticated as ${WHOAMI##*$'\n'}"

assert_linked_project() {
  local file="$REPO_ROOT/.vercel/project.json"
  [[ -f "$file" ]] || die "expected $file to exist after linking, but it does not."

  local org_id project_id
  org_id=$(node -p "require('$file').orgId || ''")
  project_id=$(node -p "require('$file').projectId || ''")

  [[ "$org_id" == "$EXPECTED_ORG_ID" ]] \
    || die ".vercel/project.json orgId is '$org_id', expected '$EXPECTED_ORG_ID' ($VERCEL_SCOPE). Delete .vercel/ and re-run."
  [[ "$project_id" == "$EXPECTED_PROJECT_ID" ]] \
    || die ".vercel/project.json projectId is '$project_id', expected '$EXPECTED_PROJECT_ID' ($VERCEL_PROJECT_NAME). Delete .vercel/ and re-run."
}

# --- 2. Link ---------------------------------------------------------

if [[ -n "${VERCEL_ORG_ID:-}" && -n "${VERCEL_PROJECT_ID:-}" ]]; then
  echo "Using VERCEL_ORG_ID / VERCEL_PROJECT_ID from the environment."
  echo "Target: $VERCEL_SCOPE/$VERCEL_PROJECT_NAME"
elif [[ -f "$REPO_ROOT/.vercel/project.json" ]]; then
  assert_linked_project
  echo "Already linked to $VERCEL_SCOPE/$VERCEL_PROJECT_NAME"
else
  step "Linking to $VERCEL_SCOPE/$VERCEL_PROJECT_NAME"
  vercel_cli link --yes --project "$VERCEL_PROJECT_NAME" >/dev/null
  assert_linked_project
  echo "Linked to $VERCEL_SCOPE/$VERCEL_PROJECT_NAME"
fi

# --- 3. Build --------------------------------------------------------

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  step "Skipping build (--skip-build)"
  [[ -d "$REPO_ROOT/site/dist" ]] || die "--skip-build was passed but site/dist does not exist."
else
  step "Building site"
  npm run build:site
fi

[[ -f "$REPO_ROOT/site/dist/index.html" ]] \
  || die "site/dist/index.html is missing — the build did not produce a site."

# --- 4. Assemble Build Output API v3 payload -------------------------

step "Assembling .vercel/output"

OUTPUT_DIR="$REPO_ROOT/.vercel/output"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/static"
cp -R "$REPO_ROOT/site/dist/." "$OUTPUT_DIR/static/"

# site/public/CNAME rides along into the upload and gets served as an
# inert /CNAME file. It's a GitHub Pages artifact, kept on purpose so
# the Pages deployment keeps its domain binding as a fallback during
# the domain transition. Delete it once harness.mikelyons.org is fully
# cut over.
#
# Minimal config: no cleanUrls, no trailingSlash, no routes. See the
# "URL paths must not change" note above before adding anything here.
printf '{"version":3}\n' > "$OUTPUT_DIR/config.json"

echo "$(find "$OUTPUT_DIR/static" -type f | wc -l | tr -d ' ') files staged"

# --- 5. Deploy -------------------------------------------------------

# --target is always passed explicitly. A bare `vercel deploy` does NOT
# mean "preview" here: this project has no Git integration, and for
# non-Git projects the CLI defaults to the production target and moves
# the production alias. Omitting the flag once already shipped a
# supposedly-preview run to production.
DEPLOY_LOG=$(mktemp)
trap 'rm -f "$DEPLOY_LOG"' EXIT

if [[ "$PROD" -eq 1 ]]; then
  step "Deploying to production"
  DEPLOY_OUT=$(vercel_cli deploy --prebuilt --target=production 2> >(tee "$DEPLOY_LOG" >&2))
else
  step "Deploying preview"
  DEPLOY_OUT=$(vercel_cli deploy --prebuilt --target=preview 2> >(tee "$DEPLOY_LOG" >&2))
fi

DEPLOY_URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -Eo 'https://[A-Za-z0-9.-]+\.vercel\.app' | tail -n 1)

[[ "$DEPLOY_URL" == https://* ]] \
  || die "could not parse a deployment URL from the vercel output:"$'\n'"$DEPLOY_OUT"

echo "Deployed: $DEPLOY_URL"

# Which URL to verify. Per-deployment URLs (…-<hash>-mike-personal.
# vercel.app) sit behind Deployment Protection even for production
# deploys; the production *alias* is the public one, and it's what
# actually serves users. So for --prod we verify the alias the CLI
# reports on its "Aliased:" line, falling back to the deployment URL if
# the line isn't there.
VERIFY_URL="$DEPLOY_URL"
if [[ "$PROD" -eq 1 ]]; then
  ALIAS_URL=$(grep -Eo 'Aliased: +https://[A-Za-z0-9.-]+' "$DEPLOY_LOG" \
    | grep -Eo 'https://[A-Za-z0-9.-]+' | tail -n 1 || true)
  if [[ -n "$ALIAS_URL" ]]; then
    VERIFY_URL="$ALIAS_URL"
    echo "Production alias: $ALIAS_URL"
  else
    echo "warning: no 'Aliased:' line in the CLI output; verifying the deployment URL instead." >&2
  fi
fi

# --- 6. Verify the critical paths ------------------------------------

if [[ "$SKIP_VERIFY" -eq 1 ]]; then
  step "Skipping verification (--skip-verify)"
  echo "$DEPLOY_URL"
  exit 0
fi

step "Verifying URL paths against $VERIFY_URL"

TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_BODY"' EXIT

# Under Vercel's default "Standard Protection" the production alias is
# public but preview / per-deployment URLs sit behind an SSO redirect,
# so an unauthenticated preview check can't see the site at all. Set
# VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment
# Protection → Protection Bypass for Automation) to verify previews.
CURL_HEADERS=()
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  CURL_HEADERS+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
fi

failures=0
sso_gated=0
for entry in "${CRITICAL_PATHS[@]}"; do
  path="${entry%%|*}"
  kind="${entry##*|}"

  # Deliberately NOT -L. A redirect is a failure, not something to
  # follow: the whole point of this check is that these paths still
  # resolve exactly as shipped clients request them. Following
  # redirects would let a cleanUrls-style /foo.html -> /foo rewrite
  # report a cheerful 200 — and it also silently turned Vercel's SSO
  # gate into six false passes the first time this ran.
  read -r status ctype redirect < <(
    curl -sS --max-time 30 -o "$TMP_BODY" ${CURL_HEADERS[@]+"${CURL_HEADERS[@]}"} \
      -w '%{http_code} %{content_type} %{redirect_url}\n' "$VERIFY_URL$path"
  ) || { printf '  \033[31mFAIL\033[0m %-36s request failed\n' "$path"; failures=$((failures + 1)); continue; }

  if [[ "$redirect" == *"vercel.com/sso-api"* ]]; then
    printf '  \033[31mFAIL\033[0m %-36s gated by Deployment Protection\n' "$path"
    sso_gated=1
    failures=$((failures + 1))
    continue
  fi

  if [[ "$status" != "200" ]]; then
    printf '  \033[31mFAIL\033[0m %-36s HTTP %s\n' "$path" "$status"
    failures=$((failures + 1))
    continue
  fi

  case "$kind" in
    json)
      if [[ "$ctype" != application/json* ]]; then
        printf '  \033[31mFAIL\033[0m %-36s content-type is %s, expected application/json\n' "$path" "$ctype"
        failures=$((failures + 1))
        continue
      fi
      # A 200 serving an HTML error page would pass a status check; parse it.
      if ! node -e "JSON.parse(require('fs').readFileSync('$TMP_BODY','utf8'))" 2>/dev/null; then
        printf '  \033[31mFAIL\033[0m %-36s body is not valid JSON\n' "$path"
        failures=$((failures + 1))
        continue
      fi
      ;;
    html)
      if [[ "$ctype" != text/html* ]]; then
        printf '  \033[31mFAIL\033[0m %-36s content-type is %s, expected text/html\n' "$path" "$ctype"
        failures=$((failures + 1))
        continue
      fi
      ;;
  esac

  printf '  \033[32mok\033[0m   %-36s 200 %s\n' "$path" "${ctype%%;*}"
done

if [[ "$failures" -gt 0 ]]; then
  echo
  if [[ "$sso_gated" -eq 1 ]]; then
    die "this deployment is behind Vercel Deployment Protection, so the paths could not be checked. Set VERCEL_AUTOMATION_BYPASS_SECRET, or open $VERIFY_URL in a logged-in browser to eyeball it by hand."
  fi
  die "$failures critical path(s) failed verification on $VERIFY_URL. See the 'URL paths must not change' note at the top of this script."
fi

step "Done"
echo "$DEPLOY_URL"
