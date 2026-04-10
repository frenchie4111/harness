import { execFile } from 'child_process'
import { promisify } from 'util'
import { log } from './debug'
import { getSecret } from './secrets'

const execFileAsync = promisify(execFile)

export interface CheckStatus {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error'
  description: string
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
}

function getToken(): string | null {
  return getSecret('githubToken') || process.env.GITHUB_TOKEN || null
}

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
async function getRepoInfo(worktreePath: string): Promise<{ owner: string; repo: string } | null> {
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

/** Make an authenticated request to the GitHub REST API */
async function githubFetch(url: string): Promise<unknown> {
  const token = getToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Harness',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`)
  }
  return res.json()
}

interface ApiPR {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  merged_at: string | null
  html_url: string
  head: { ref: string; sha: string }
}

interface ApiCheckRun {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  output?: { title?: string | null }
}

interface ApiCheckRunsResponse {
  total_count: number
  check_runs: ApiCheckRun[]
}

interface ApiStatus {
  state: 'error' | 'failure' | 'pending' | 'success'
  context: string
  description: string | null
}

interface ApiCombinedStatus {
  state: 'success' | 'pending' | 'failure'
  statuses: ApiStatus[]
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

/** Get PR status for the branch checked out in a worktree. Returns null if no PR or no token. */
export async function getPRStatus(worktreePath: string): Promise<PRStatus | null> {
  const token = getToken()
  if (!token) return null

  const repoInfo = await getRepoInfo(worktreePath)
  if (!repoInfo) return null

  const branchName = await getCurrentBranch(worktreePath)
  if (!branchName) return null

  const { owner, repo } = repoInfo

  try {
    // Find the PR(s) for this branch. head filter format: "owner:branch"
    const prList = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branchName)}&state=all&per_page=1`
    ) as ApiPR[]

    if (!Array.isArray(prList) || prList.length === 0) return null

    const pr = prList[0]
    const sha = pr.head.sha

    // Fetch check runs AND status contexts for the SHA in parallel
    const [checkRunsRes, combinedRes] = await Promise.all([
      githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`) as Promise<ApiCheckRunsResponse>,
      githubFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`) as Promise<ApiCombinedStatus>
    ])

    const checks: CheckStatus[] = []
    for (const run of checkRunsRes.check_runs || []) {
      checks.push({
        name: run.name,
        state: normalizeCheckState(run.status, run.conclusion),
        description: run.output?.title || ''
      })
    }
    for (const s of combinedRes.statuses || []) {
      checks.push({
        name: s.context,
        state: normalizeStatusState(s.state),
        description: s.description || ''
      })
    }

    // Determine PR state
    let state: PRStatus['state']
    if (pr.merged_at) state = 'merged'
    else if (pr.state === 'closed') state = 'closed'
    else if (pr.draft) state = 'draft'
    else state = 'open'

    return {
      number: pr.number,
      title: pr.title,
      state,
      url: pr.html_url,
      branch: branchName,
      checks,
      checksOverall: computeOverall(checks)
    }
  } catch (err) {
    log('github', `getPRStatus failed for ${branchName}`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Star a repository on behalf of the authenticated user. Idempotent. */
export async function starRepo(token: string, owner: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
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

/** Test a token by making an authenticated request to /user. Returns the username if valid. */
export async function testToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch('https://api.github.com/user', {
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
