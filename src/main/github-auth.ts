import { execFile } from 'child_process'
import { promisify } from 'util'
import { log } from './debug'
import { getSecret } from './secrets'

const execFileAsync = promisify(execFile)

export type TokenSource = 'pat' | 'gh-cli'

interface ResolvedToken {
  token: string
  source: TokenSource
}

let cached: ResolvedToken | null = null
let resolving: Promise<ResolvedToken | null> | null = null

/** Probe GET /user to confirm the token works. Returns scopes on success. */
async function probeToken(token: string): Promise<{ ok: boolean; scopes: string[]; status: number }> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`
      }
    })
    const scopesHeader = res.headers.get('x-oauth-scopes') || ''
    const scopes = scopesHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return { ok: res.ok, scopes, status: res.status }
  } catch (err) {
    log('github-auth', 'probe failed', err instanceof Error ? err.message : err)
    return { ok: false, scopes: [], status: 0 }
  }
}

const DESIRED_SCOPES = ['repo', 'read:org']

function warnIfScopesShort(source: TokenSource, scopes: string[]): void {
  // Fine-grained PATs return an empty x-oauth-scopes header — don't warn
  // on empty, only on explicitly-present-but-insufficient classic scopes.
  if (scopes.length === 0) return
  const missing = DESIRED_SCOPES.filter(
    (needed) => !scopes.some((s) => s === needed || s.startsWith(`${needed}:`))
  )
  if (missing.length > 0) {
    log('github-auth', `${source} token missing desired scopes: ${missing.join(', ')} (have: ${scopes.join(', ')})`)
  }
}

/** Try reading a token from `gh auth token`. Returns null if gh is absent or not logged in. */
async function readGhCliToken(): Promise<string | null> {
  try {
    // Use login shell so Homebrew's gh is on PATH, matching PtyManager.
    const { stdout } = await execFileAsync('/bin/zsh', ['-ilc', 'gh auth token'], {
      timeout: 3000
    })
    const token = stdout.trim()
    if (!token) return null
    return token
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // ENOENT / non-zero exit / timeout are all "not available" — fall through silently.
    log('github-auth', `gh auth token unavailable: ${msg}`)
    return null
  }
}

async function doResolve(): Promise<ResolvedToken | null> {
  // 1. Explicit PAT from secrets or env wins.
  const pat = getSecret('githubToken') || process.env.GITHUB_TOKEN || null
  if (pat) {
    const probe = await probeToken(pat)
    if (probe.ok) {
      warnIfScopesShort('pat', probe.scopes)
      log('github-auth', 'resolved token source=pat')
      return { token: pat, source: 'pat' }
    }
    log('github-auth', `PAT probe failed (status ${probe.status}), falling through to gh CLI`)
  }

  // 2. gh CLI.
  const ghToken = await readGhCliToken()
  if (ghToken) {
    const probe = await probeToken(ghToken)
    if (probe.ok) {
      warnIfScopesShort('gh-cli', probe.scopes)
      log('github-auth', 'resolved token source=gh-cli')
      return { token: ghToken, source: 'gh-cli' }
    }
    log('github-auth', `gh CLI token probe failed (status ${probe.status})`)
  }

  // 3. Nothing.
  log('github-auth', 'no GitHub token available')
  return null
}

/** Resolve and cache a GitHub token. Safe to call concurrently — only one resolution runs at a time. */
export async function resolveGitHubToken(): Promise<ResolvedToken | null> {
  if (cached) return cached
  if (resolving) return resolving
  resolving = doResolve().then((result) => {
    cached = result
    resolving = null
    return result
  })
  return resolving
}

/** Synchronous read of the cached token. Returns null if resolve hasn't been called yet or failed. */
export function getCachedToken(): string | null {
  return cached?.token ?? null
}

/** Current auth source, or null if unresolved. */
export function getTokenSource(): TokenSource | null {
  return cached?.source ?? null
}

/** Drop the cached token so the next resolveGitHubToken() call re-probes. */
export function invalidateTokenCache(): void {
  log('github-auth', 'invalidating token cache')
  cached = null
}
