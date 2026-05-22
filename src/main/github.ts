import { execFile } from 'child_process'
import { promisify } from 'util'
import { log, formatErr } from './debug'
import { getCachedToken, invalidateTokenCache, resolveGitHubToken } from './github-auth'
import { trackedFetch } from './github-recorder'
import type { CheckStatus, PRReview, PRStatus } from '../shared/state/prs'
import type { PRSummary, PRMetadata } from '../shared/github-types'

export type { CheckStatus, PRReview, PRStatus, PRSummary, PRMetadata }

const execFileAsync = promisify(execFile)

/** Parse the GitHub owner/repo from a remote URL like git@github.com:owner/repo.git or https://github.com/owner/repo.git */
function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }
  return null
}

/** Get the GitHub owner/repo for the given worktree by inspecting its origin remote */
export async function getRepoInfo(worktreePath: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: worktreePath }
    )
    return parseRemoteUrl(stdout.trim())
  } catch {
    return null
  }
}

/** Get the current branch of a worktree */
async function getCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: worktreePath }
    )
    const branch = stdout.trim()
    if (!branch || branch === 'HEAD') return null
    return branch
  } catch {
    return null
  }
}

async function doFetch(url: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Harness',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return trackedFetch(url, { headers })
}

/** Make an authenticated request to the GitHub REST API. On 401, invalidate the token cache and retry once. */
async function githubFetch(url: string): Promise<unknown> {
  let token = getCachedToken()
  let res = await doFetch(url, token)
  if (res.status === 401) {
    log('github', '401 from GitHub, re-resolving token')
    invalidateTokenCache()
    const resolved = await resolveGitHubToken()
    token = resolved?.token ?? null
    res = await doFetch(url, token)
  }
  if (!res.ok) {
    const path = url.replace(/^https:\/\/api\.github\.com/, '')
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${path}`)
  }
  return res.json()
}

type ParentInfo = { owner: string; repo: string } | 'self'
const forkParentCache = new Map<string, ParentInfo>()

/** Origin (= what `remote.origin.url` points at) plus the repo we should
 *  query for PR data. For non-forks the two are equal; for forks
 *  `upstream` is the parent repo where PRs are typically opened. */
export interface RepoContext {
  origin: { owner: string; repo: string }
  upstream: { owner: string; repo: string }
}

/** Read origin from the worktree and resolve upstream via GitHub. Returns
 *  null if the worktree has no parseable origin remote. Fork detection is
 *  cached per-process. */
export async function getRepoContext(worktreePath: string): Promise<RepoContext | null> {
  const origin = await getRepoInfo(worktreePath)
  if (!origin) return null
  const upstream = await resolveQueryRepo(origin)
  return { origin, upstream }
}

/** Resolve which repo to query for PR data. When `origin` is a fork on
 *  GitHub, PRs are typically opened against the parent repo, so we query
 *  upstream's pulls list instead. Result is cached per-process. On error
 *  the cache is left empty so the next poll retries. */
async function resolveQueryRepo(
  origin: { owner: string; repo: string }
): Promise<{ owner: string; repo: string }> {
  const key = `${origin.owner}/${origin.repo}`
  const cached = forkParentCache.get(key)
  if (cached === 'self') return origin
  if (cached) return cached
  try {
    const data = (await githubFetch(
      `https://api.github.com/repos/${origin.owner}/${origin.repo}`
    )) as { fork?: boolean; parent?: { owner: { login: string }; name: string } }
    if (data.fork && data.parent) {
      const parent = { owner: data.parent.owner.login, repo: data.parent.name }
      forkParentCache.set(key, parent)
      log('github', `detected fork ${key} → upstream ${parent.owner}/${parent.repo}`)
      return parent
    }
    forkParentCache.set(key, 'self')
    return origin
  } catch (err) {
    log('github', `fork detection failed for ${key}`, formatErr(err))
    return origin
  }
}

interface ApiPRListItem {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  merged_at: string | null
  html_url: string
  user: { login: string; avatar_url: string } | null
  base: { ref: string; repo: { full_name: string } | null } | null
  head: {
    ref: string
    sha: string
    repo: { full_name: string } | null
  }
  updated_at: string
}

interface ApiPRDetail extends ApiPRListItem {
  mergeable: boolean | null
  mergeable_state: string
  additions: number
  deletions: number
}

/** Normalized PR list item used by the poller's match-by-ref/sha logic.
 *  Flattened from the GitHub API shape so callers don't have to chase
 *  optional nested fields. */
export interface PRListItem {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  mergedAt: string | null
  url: string
  headRef: string
  headSha: string
  /** owner/repo of the head — null when the head repo is gone (rare). */
  headRepoFullName: string | null
  baseRef: string
  baseRepoFullName: string | null
  /** Login + avatar for the PR author. Null when GitHub redacts (rare). */
  author: { login: string; avatarUrl: string } | null
  updatedAt: string
}

function flattenListItem(it: ApiPRListItem): PRListItem {
  return {
    number: it.number,
    title: it.title,
    state: it.state,
    draft: it.draft,
    mergedAt: it.merged_at,
    url: it.html_url,
    headRef: it.head?.ref ?? '',
    headSha: it.head?.sha ?? '',
    headRepoFullName: it.head?.repo?.full_name ?? null,
    baseRef: it.base?.ref ?? '',
    baseRepoFullName: it.base?.repo?.full_name ?? null,
    author: it.user ? { login: it.user.login, avatarUrl: it.user.avatar_url } : null,
    updatedAt: it.updated_at
  }
}

interface ApiCheckRun {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  html_url?: string | null
  details_url?: string | null
  output?: { title?: string | null; summary?: string | null }
}

interface ApiCheckRunsResponse {
  total_count: number
  check_runs: ApiCheckRun[]
}

interface ApiStatus {
  state: 'error' | 'failure' | 'pending' | 'success'
  context: string
  description: string | null
  target_url: string | null
}

interface ApiCombinedStatus {
  state: 'success' | 'pending' | 'failure'
  statuses: ApiStatus[]
}

interface ApiReview {
  user: { login: string; avatar_url: string }
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submitted_at: string
  html_url: string
}

function normalizeCheckState(
  status: ApiCheckRun['status'],
  conclusion: ApiCheckRun['conclusion']
): CheckStatus['state'] {
  if (conclusion) {
    switch (conclusion) {
      case 'success':
        return 'success'
      case 'failure':
      case 'timed_out':
      case 'action_required':
      case 'cancelled':
        return 'failure'
      case 'neutral':
        return 'neutral'
      case 'skipped':
        return 'skipped'
      default:
        return 'neutral'
    }
  }
  if (status === 'completed') return 'success'
  return 'pending'
}

function normalizeStatusState(state: ApiStatus['state']): CheckStatus['state'] {
  switch (state) {
    case 'success':
      return 'success'
    case 'failure':
    case 'error':
      return 'failure'
    case 'pending':
      return 'pending'
    default:
      return 'neutral'
  }
}

function computeOverall(checks: CheckStatus[]): PRStatus['checksOverall'] {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.state === 'failure' || c.state === 'error')) return 'failure'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  return 'success'
}

/** List the 100 most-recently-updated PRs for a repo, in any state.
 *  Caller matches each worktree against this list (by head ref / sha)
 *  instead of doing one API call per worktree.
 *
 *  Returns null only when authoritatively there's nothing to fetch: no
 *  token, or no parseable origin remote. Throws on transport/server
 *  failure so callers can preserve previously-cached PR state instead
 *  of treating "offline" as "no PR exists" — see PRPoller.refreshAll. */
export async function listPullRequests(repoRoot: string): Promise<PRListItem[] | null> {
  const token = getCachedToken()
  if (!token) return null
  const repoInfo = await getRepoInfo(repoRoot)
  if (!repoInfo) return null
  const queryRepo = await resolveQueryRepo(repoInfo)
  const { owner, repo } = queryRepo
  try {
    const list = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`
    )) as ApiPRListItem[]
    if (!Array.isArray(list)) {
      throw new Error(`listPullRequests: unexpected response shape for ${owner}/${repo}`)
    }
    return list.map(flattenListItem)
  } catch (err) {
    log('github', `listPullRequests failed for ${owner}/${repo}`, formatErr(err))
    throw err
  }
}

/** Build a full PRStatus for a known PR (item from listPullRequests).
 *  Fans out check-runs / status / reviews / mergeability in parallel,
 *  then assembles. `localBranch` is the worktree's current branch (just
 *  carried through into PRStatus.branch for the UI). */
export async function loadPRStatusForItem(
  worktreePath: string,
  item: PRListItem,
  baseRepo: { owner: string; repo: string }
): Promise<PRStatus | null> {
  const token = getCachedToken()
  if (!token) return null
  const localBranch = (await getCurrentBranch(worktreePath)) ?? item.headRef
  try {
    return await fanOutPRDetails(baseRepo.owner, baseRepo.repo, item, localBranch)
  } catch (err) {
    log(
      'github',
      `loadPRStatusForItem failed for ${baseRepo.owner}/${baseRepo.repo}#${item.number}`,
      formatErr(err)
    )
    throw err
  }
}

async function fanOutPRDetails(
  owner: string,
  repo: string,
  item: PRListItem,
  branchName: string
): Promise<PRStatus | null> {
  const sha = item.headSha
  const [prDetailRes, checkRunsRes, combinedRes, reviewsRes] = await Promise.allSettled([
    githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${item.number}`) as Promise<ApiPRDetail>,
    githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`) as Promise<ApiCheckRunsResponse>,
    githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`) as Promise<ApiCombinedStatus>,
    githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${item.number}/reviews?per_page=100`) as Promise<ApiReview[]>
  ])

  if (prDetailRes.status === 'rejected') throw prDetailRes.reason
  const prDetail = prDetailRes.value
  if (!prDetail || typeof prDetail.number !== 'number') return null

  if (checkRunsRes.status === 'rejected') {
    log('github', `check-runs unavailable for ${owner}/${repo}#${item.number} (continuing)`, formatErr(checkRunsRes.reason))
  }
  if (combinedRes.status === 'rejected') {
    log('github', `combined status unavailable for ${owner}/${repo}#${item.number} (continuing)`, formatErr(combinedRes.reason))
  }
  if (reviewsRes.status === 'rejected') {
    log('github', `reviews unavailable for ${owner}/${repo}#${item.number} (continuing)`, formatErr(reviewsRes.reason))
  }

  let hasConflict: boolean | null
  if (prDetail.mergeable_state === 'dirty') hasConflict = true
  else if (prDetail.mergeable === false) hasConflict = true
  else if (prDetail.mergeable === true) hasConflict = false
  else hasConflict = null

  const checks: CheckStatus[] = []
  const checkRuns = checkRunsRes.status === 'fulfilled' ? checkRunsRes.value.check_runs || [] : []
  for (const run of checkRuns) {
    checks.push({
      name: run.name,
      state: normalizeCheckState(run.status, run.conclusion),
      description: run.output?.title || '',
      summary: run.output?.summary || undefined,
      detailsUrl: run.html_url || run.details_url || undefined
    })
  }
  const combinedStatuses = combinedRes.status === 'fulfilled' ? combinedRes.value.statuses || [] : []
  for (const s of combinedStatuses) {
    checks.push({
      name: s.context,
      state: normalizeStatusState(s.state),
      description: s.description || '',
      detailsUrl: s.target_url || undefined
    })
  }

  const reviewsList = reviewsRes.status === 'fulfilled' ? reviewsRes.value : []
  const reviews: PRReview[] = (Array.isArray(reviewsList) ? reviewsList : [])
    .filter((r) => r.user && r.state !== 'PENDING')
    .map((r) => ({
      user: r.user.login,
      avatarUrl: r.user.avatar_url,
      state: r.state,
      body: r.body || '',
      submittedAt: r.submitted_at,
      htmlUrl: r.html_url
    }))

  const latestByUser = new Map<string, PRReview['state']>()
  for (const r of reviews) latestByUser.set(r.user, r.state)
  const latestStates = [...latestByUser.values()]
  let reviewDecision: PRStatus['reviewDecision'] = 'none'
  if (latestStates.some((s) => s === 'CHANGES_REQUESTED')) reviewDecision = 'changes_requested'
  else if (latestStates.some((s) => s === 'APPROVED')) reviewDecision = 'approved'
  else if (latestStates.length > 0) reviewDecision = 'review_required'

  let state: PRStatus['state']
  if (item.mergedAt) state = 'merged'
  else if (item.state === 'closed') state = 'closed'
  else if (item.draft) state = 'draft'
  else state = 'open'

  return {
    number: item.number,
    title: item.title,
    state,
    url: item.url,
    branch: branchName,
    author: item.author,
    checks,
    checksOverall: computeOverall(checks),
    hasConflict,
    reviews,
    reviewDecision,
    additions: prDetail.additions,
    deletions: prDetail.deletions
  }
}

/** Check whether the authenticated user has starred the repo. */
export async function isRepoStarred(token: string, owner: string, repo: string): Promise<boolean | null> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`
      }
    })
    if (res.status === 204) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

/** Unstar a repository. Idempotent. */
export async function unstarRepo(token: string, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 204) return { ok: true }
    return { ok: false, error: `${res.status} ${res.statusText}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Star a repository on behalf of the authenticated user. Idempotent. */
export async function starRepo(token: string, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await trackedFetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Length': '0'
      }
    })
    if (res.status === 204 || res.status === 304) return { ok: true }
    return { ok: false, error: `${res.status} ${res.statusText}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergePRResult {
  ok: boolean
  error?: string
  errorCode?: 'unauthorized' | 'method_not_allowed' | 'conflict' | 'unprocessable' | 'unknown'
  sha?: string
}

/** Merge a pull request via GitHub's REST API. Mirrors the auth/error
 * style of getPRStatus: resolves the cached token, retries once on 401
 * after re-resolving. */
export async function mergePR(
  token: string,
  owner: string,
  repo: string,
  number: number,
  method: GitHubMergeMethod,
  opts?: { commitTitle?: string; commitMessage?: string }
): Promise<MergePRResult> {
  const body: Record<string, unknown> = { merge_method: method }
  if (opts?.commitTitle !== undefined) body.commit_title = opts.commitTitle
  if (opts?.commitMessage !== undefined) body.commit_message = opts.commitMessage

  let res: Response
  try {
    res = await trackedFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('github', `mergePR fetch failed for ${owner}/${repo}#${number}`, formatErr(err))
    return { ok: false, error: message, errorCode: 'unknown' }
  }

  if (res.status === 200) {
    try {
      const data = (await res.json()) as { sha?: string; merged?: boolean }
      return { ok: true, sha: data.sha }
    } catch {
      return { ok: true }
    }
  }

  let apiMessage = ''
  try {
    const data = (await res.json()) as { message?: string }
    apiMessage = data?.message || ''
  } catch {
    // ignore — fall back to status text
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: 'Unauthorized — check that your token has repo scope',
      errorCode: 'unauthorized'
    }
  }
  if (res.status === 405) {
    return {
      ok: false,
      error: 'Branch protection forbids this merge method',
      errorCode: 'method_not_allowed'
    }
  }
  if (res.status === 409) {
    return {
      ok: false,
      error: 'PR has merge conflicts — resolve them and try again',
      errorCode: 'conflict'
    }
  }
  if (res.status === 422) {
    return {
      ok: false,
      error: 'PR not in a mergeable state (draft, blocked by checks, etc.)',
      errorCode: 'unprocessable'
    }
  }
  return {
    ok: false,
    error: apiMessage || `${res.status} ${res.statusText}`,
    errorCode: 'unknown'
  }
}

function toPRSummary(pr: ApiPRListItem): PRSummary {
  const baseRepo = pr.base?.repo?.full_name ?? null
  const headRepo = pr.head?.repo?.full_name ?? null
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user
      ? { login: pr.user.login, avatarUrl: pr.user.avatar_url }
      : null,
    baseBranch: pr.base?.ref ?? '',
    headBranch: pr.head?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    headRepoFullName: headRepo,
    isFork: !!baseRepo && !!headRepo && baseRepo !== headRepo,
    updatedAt: pr.updated_at,
    url: pr.html_url,
    draft: pr.draft
  }
}

/** List the most recently updated open PRs for the given local repo.
 *  Returns null on auth/network failure so callers can show a graceful
 *  empty/error state. Capped at 50 to keep the modal fast. */
export async function listOpenPRs(repoRoot: string): Promise<PRSummary[] | null> {
  const repoInfo = await getRepoInfo(repoRoot)
  if (!repoInfo) return null
  const { owner, repo } = repoInfo
  try {
    const list = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`
    )) as ApiPRListItem[]
    if (!Array.isArray(list)) return null
    return list.map(toPRSummary)
  } catch (err) {
    log('github', `listOpenPRs failed for ${owner}/${repo}`, formatErr(err))
    return null
  }
}

/** Fetch a single PR's metadata (head SHA + base branch). Used as a
 *  cheap freshness check immediately before creating a worktree. */
export async function getPRMetadata(
  repoRoot: string,
  prNumber: number
): Promise<PRMetadata | null> {
  const repoInfo = await getRepoInfo(repoRoot)
  if (!repoInfo) return null
  const { owner, repo } = repoInfo
  try {
    const pr = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
    )) as ApiPRListItem
    if (!pr || typeof pr.number !== 'number') return null
    return toPRSummary(pr)
  } catch (err) {
    log('github', `getPRMetadata failed for ${owner}/${repo}#${prNumber}`, formatErr(err))
    return null
  }
}

/** Test a token by making an authenticated request to /user. Returns the username if valid. */
export async function testToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await trackedFetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`
      }
    })
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}` }
    }
    const data = await res.json() as { login: string }
    return { ok: true, username: data.login }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
