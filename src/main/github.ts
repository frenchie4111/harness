import { execFile } from 'child_process'
import { promisify } from 'util'
import { log, formatErr } from './debug'
import { getCachedToken, invalidateTokenCache, resolveGitHubToken } from './github-auth'
import { trackedFetch } from './github-recorder'
import type { CheckStatus, PRReview, PRStatus } from '../shared/state/prs'
import type {
  PRSummary,
  PRMetadata,
  ReviewSyncComment,
  ReviewSyncInput,
  ReviewSyncResult
} from '../shared/github-types'

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

/** Earliest tag (by version-sort) that contains the given commit, or null
 *  if no tag does / git can't reach the SHA. Used for merged-PR display. */
async function getFirstTagContaining(worktreePath: string, sha: string): Promise<string | null> {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['tag', '--contains', sha, '--sort=version:refname'],
      { cwd: worktreePath }
    )
    const first = stdout.split('\n').map((s) => s.trim()).find((s) => s.length > 0)
    return first ?? null
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

/** Fetches commits-behind via GitHub's compare endpoint. Returns null on
 *  any failure — the count is a nice-to-have, not a correctness signal. */
async function fetchBehindBy(
  owner: string,
  repo: string,
  baseRef: string,
  headSha: string
): Promise<number | null> {
  try {
    const data = (await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`
    )) as { behind_by?: number } | null
    if (!data || typeof data.behind_by !== 'number') return null
    return data.behind_by
  } catch (err) {
    log('github', `fetchBehindBy failed for ${owner}/${repo} ${baseRef}...${headSha}`, err instanceof Error ? err.message : err)
    return null
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
  assignees: { login: string; avatar_url: string }[] | null
  updated_at: string
}

function computeOverall(checks: CheckStatus[]): PRStatus['checksOverall'] {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.state === 'failure' || c.state === 'error')) return 'failure'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  return 'success'
}

export interface PRStatusRequest {
  /** Worktree path — used as the result map key. */
  worktreePath: string
  /** Local branch name — the PR's head ref on the origin remote.
   *  Empty / detached worktrees are skipped (result map gets null). */
  branch: string
  /** Worktree HEAD SHA — used to disambiguate when multiple PRs share a
   *  branch name (e.g. several forks contributing branches called "fix"). */
  headSha: string
}

interface GraphQLActor {
  login?: string | null
  avatarUrl?: string | null
}

interface GraphQLPR {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  mergedAt: string | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  additions: number
  deletions: number
  baseRefName: string
  baseRepository: { defaultBranchRef: { name: string } | null } | null
  headRefOid: string
  headRepository: { nameWithOwner: string } | null
  mergeCommit: { oid: string } | null
  author: GraphQLActor | null
  milestone: { title: string; url: string; state: 'OPEN' | 'CLOSED' } | null
  assignees: { nodes: Array<GraphQLActor | null> | null } | null
  labels: { nodes: Array<{ name: string; color: string; description: string | null } | null> | null } | null
  mergeQueueEntry: { position: number; estimatedTimeToMerge: number | null } | null
  closingIssuesReferences: {
    nodes: Array<{ number: number; title: string; state: 'OPEN' | 'CLOSED'; url: string } | null> | null
  } | null
  reviews: {
    nodes: Array<{
      author: GraphQLActor | null
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
      body: string
      submittedAt: string
      url: string
    } | null> | null
  } | null
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: { nodes: Array<GraphQLCheckContext | null> | null } | null
        } | null
      }
    } | null> | null
  } | null
}

type GraphQLCheckContext =
  | {
      __typename: 'CheckRun'
      name: string
      status:
        | 'QUEUED'
        | 'IN_PROGRESS'
        | 'COMPLETED'
        | 'WAITING'
        | 'PENDING'
        | 'REQUESTED'
      conclusion:
        | 'SUCCESS'
        | 'FAILURE'
        | 'NEUTRAL'
        | 'CANCELLED'
        | 'SKIPPED'
        | 'TIMED_OUT'
        | 'ACTION_REQUIRED'
        | 'STALE'
        | 'STARTUP_FAILURE'
        | null
      detailsUrl: string | null
      permalink: string | null
      startedAt: string | null
      title: string | null
      summary: string | null
    }
  | {
      __typename: 'StatusContext'
      context: string
      state: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS'
      description: string | null
      targetUrl: string | null
      createdAt: string | null
    }

interface GraphQLBatchResponse {
  data?:
    | ({
        repository?:
          | ({
              defaultBranchRef: { name: string } | null
              milestones: { totalCount: number } | null
            } & Record<string, { nodes: GraphQLPR[] | null } | null>)
          | null
      } & Record<string, { nodes: Array<GraphQLPR | { __typename?: string }> | null } | null>)
    | null
  errors?: Array<{ message: string }> | null
}

function gqlCheckState(c: Extract<GraphQLCheckContext, { __typename: 'CheckRun' }>): CheckStatus['state'] {
  if (c.conclusion) {
    switch (c.conclusion) {
      case 'SUCCESS':
        return 'success'
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'ACTION_REQUIRED':
      case 'CANCELLED':
      case 'STARTUP_FAILURE':
        return 'failure'
      case 'NEUTRAL':
        return 'neutral'
      case 'SKIPPED':
        return 'skipped'
      case 'STALE':
        return 'neutral'
    }
  }
  if (c.status === 'COMPLETED') return 'success'
  return 'pending'
}

function gqlStatusState(s: Extract<GraphQLCheckContext, { __typename: 'StatusContext' }>['state']): CheckStatus['state'] {
  switch (s) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
      return 'pending'
    default:
      return 'neutral'
  }
}

const PR_FRAGMENT = `fragment PR on PullRequest {
  number title state isDraft url mergedAt mergeable additions deletions
  baseRefName
  baseRepository { defaultBranchRef { name } }
  headRefOid
  headRepository { nameWithOwner }
  mergeCommit { oid }
  author { login avatarUrl }
  milestone { title url state }
  assignees(first: 10) { nodes { login avatarUrl } }
  labels(first: 20) { nodes { name color description } }
  mergeQueueEntry { position estimatedTimeToMerge }
  closingIssuesReferences(first: 10) { nodes { number title state url } }
  reviews(last: 100) {
    nodes { author { login avatarUrl } state body submittedAt url }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl permalink startedAt title summary
              }
              ... on StatusContext {
                context state description targetUrl createdAt
              }
            }
          }
        }
      }
    }
  }
}`

/** Build a single GraphQL request that looks up the PR for each requested
 *  branch via headRefName. Aliased sub-queries keep the whole batch in one
 *  round-trip. Returns map: worktreePath → PRStatus|null. Throws on
 *  transport failure so the caller preserves cached state. */
export async function fetchPRStatusesForRepo(
  ctx: RepoContext,
  requests: PRStatusRequest[]
): Promise<Map<string, PRStatus | null>> {
  const result = new Map<string, PRStatus | null>()
  if (requests.length === 0) return result

  const token = getCachedToken()
  if (!token) {
    for (const r of requests) result.set(r.worktreePath, null)
    return result
  }

  // Worktrees without a branch (detached / new) can't be looked up by
  // headRefName. Mark them null up-front; don't include them in the query.
  const queryable = requests.filter((r) => r.branch && r.branch !== '(detached)')
  for (const r of requests) {
    if (!queryable.includes(r)) result.set(r.worktreePath, null)
  }
  if (queryable.length === 0) return result

  const { owner, repo } = ctx.upstream
  const originFull = `${ctx.origin.owner}/${ctx.origin.repo}`

  const varDefs = ['$owner:String!', '$name:String!']
  const repoAliasParts: string[] = []
  const topAliasParts: string[] = []
  const variables: Record<string, string> = { owner, name: repo }
  // Branch-name lookup handles the common case. SHA-via-search handles
  // both cross-fork PRs (whose commits aren't linked from the upstream's
  // associatedPullRequests index) and `gh pr checkout`-style synthetic
  // local branches whose name doesn't match the PR's head.ref. Both fire
  // in the same request so the fallback adds no extra round-trip.
  queryable.forEach((req, i) => {
    varDefs.push(`$branch${i}:String!`)
    variables[`branch${i}`] = req.branch
    repoAliasParts.push(
      `prBr${i}: pullRequests(headRefName: $branch${i}, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PR } }`
    )
    if (/^[0-9a-f]{40}$/i.test(req.headSha)) {
      varDefs.push(`$q${i}:String!`)
      variables[`q${i}`] = `type:pr repo:${owner}/${repo} ${req.headSha}`
      topAliasParts.push(
        `prSearch${i}: search(query: $q${i}, type: ISSUE, first: 5) { nodes { ... on PullRequest { ...PR } } }`
      )
    }
  })
  const query = `query(${varDefs.join(', ')}) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    milestones(first: 1) { totalCount }
    ${repoAliasParts.join('\n    ')}
  }
  ${topAliasParts.join('\n  ')}
}
${PR_FRAGMENT}`

  const res = await trackedFetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Harness',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as GraphQLBatchResponse
  if (json.errors && json.errors.length > 0) {
    log('github', `GraphQL errors for ${owner}/${repo}`, json.errors.map((e) => e.message).join('; '))
  }
  const repoData = json.data?.repository
  if (!repoData) {
    throw new Error(`GitHub GraphQL: empty repository response for ${owner}/${repo}`)
  }
  const topData = json.data ?? {}

  const hasMilestones = (repoData.milestones?.totalCount ?? 0) > 0

  const defaultBranchName = repoData.defaultBranchRef?.name ?? ''

  // Resolve per-request, then fetch behind_by + first-release-tag in parallel.
  const built = await Promise.all(
    queryable.map(async (req, i) => {
      // A worktree sitting on the repo's default branch (main/master) is
      // not the head of any PR — skip the resolution entirely to avoid
      // misattributing the latest squash-merged PR's status to it.
      if (defaultBranchName && req.branch === defaultBranchName) {
        return { worktreePath: req.worktreePath, branch: req.branch, status: null as PRStatus | null }
      }
      const brAlias = repoData[`prBr${i}`] as { nodes: GraphQLPR[] | null } | null | undefined
      const searchAlias = topData[`prSearch${i}`] as
        | { nodes: Array<GraphQLPR | { __typename?: string }> | null }
        | null
        | undefined
      const branchNodes = brAlias?.nodes ?? []
      // search returns Issue | PullRequest; filter to PR-shaped nodes only.
      const searchNodes = (searchAlias?.nodes ?? []).filter(
        (n): n is GraphQLPR => !!n && typeof (n as GraphQLPR).number === 'number'
      )
      const pr = resolvePRForWorktree(branchNodes, searchNodes, req.headSha, originFull)
      if (!pr) return { worktreePath: req.worktreePath, branch: req.branch, status: null as PRStatus | null }
      const [behindBy, firstReleaseTag] = await Promise.all([
        pr.state === 'MERGED' || pr.state === 'CLOSED'
          ? Promise.resolve(null)
          : fetchBehindBy(owner, repo, pr.baseRefName, pr.headRefOid),
        pr.state === 'MERGED' && pr.mergeCommit?.oid
          ? getFirstTagContaining(req.worktreePath, pr.mergeCommit.oid)
          : Promise.resolve(null)
      ])
      const status = buildPRStatus(pr, req.branch, behindBy, firstReleaseTag, hasMilestones)
      return { worktreePath: req.worktreePath, branch: req.branch, status }
    })
  )

  // Any branch that some PR is targeting as base (develop / integration /
  // release/*, etc.) is a merge point, not a PR head. Null out attributions
  // for worktrees sitting on one of those.
  const baseBranches = new Set<string>()
  for (const b of built) if (b.status) baseBranches.add(b.status.baseBranch)
  for (const b of built) {
    if (b.status && baseBranches.has(b.branch)) b.status = null
  }

  for (const b of built) result.set(b.worktreePath, b.status)
  return result
}

/** Resolve which PR (if any) belongs to a given worktree.
 *
 *  Branch-name nodes come from `pullRequests(headRefName: $branch)` — the
 *  filter is by ref, so any same-origin hit is a legitimate match for
 *  this branch. We prefer an exact SHA match if available, then
 *  same-origin, then the most-recently-updated.
 *
 *  Search nodes come from `search("type:pr repo:o/n <sha>")` — the index
 *  matches the SHA appearing anywhere in the PR's commit history or
 *  body, including squash-merge commits that land on the default branch.
 *  That's too loose to trust on its own, so we require the candidate's
 *  `headRefOid` to equal the worktree's HEAD SHA before accepting it. */
function resolvePRForWorktree(
  branchNodes: GraphQLPR[],
  searchNodes: GraphQLPR[],
  headSha: string,
  originFull: string
): GraphQLPR | null {
  if (headSha) {
    const bySha =
      branchNodes.find((n) => n.headRefOid === headSha) ??
      searchNodes.find((n) => n.headRefOid === headSha)
    if (bySha) return bySha
  }
  // No SHA match. Same-origin branch-name hit is still a legitimate
  // match (worktree slightly behind the PR head, or PR force-pushed).
  // Cross-fork branch-name hits are ignored — `feature/foo` on someone
  // else's fork is not our PR.
  const sameRepo = branchNodes.find((n) => n.headRepository?.nameWithOwner === originFull)
  if (sameRepo) return sameRepo
  return null
}

function buildPRStatus(
  pr: GraphQLPR,
  branchName: string,
  behindBy: number | null,
  firstReleaseTag: string | null,
  hasMilestones: boolean
): PRStatus {
  // Dedupe by check name, keeping the latest startedAt — GraphQL's
  // statusCheckRollup returns one entry per re-run of a check, and the
  // renderer keys by name.
  const byName = new Map<string, CheckStatus>()
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  for (const c of contexts) {
    if (!c) continue
    const entry: CheckStatus =
      c.__typename === 'CheckRun'
        ? {
            name: c.name,
            state: gqlCheckState(c),
            description: c.title || '',
            summary: c.summary || undefined,
            detailsUrl: c.permalink || c.detailsUrl || undefined,
            startedAt: c.startedAt || undefined
          }
        : {
            name: c.context,
            state: gqlStatusState(c.state),
            description: c.description || '',
            detailsUrl: c.targetUrl || undefined,
            startedAt: c.createdAt || undefined
          }
    const prev = byName.get(entry.name)
    if (!prev || (entry.startedAt ?? '') >= (prev.startedAt ?? '')) {
      byName.set(entry.name, entry)
    }
  }
  const checks: CheckStatus[] = [...byName.values()]

  const reviewNodes = pr.reviews?.nodes ?? []
  const reviews: PRReview[] = []
  for (const r of reviewNodes) {
    if (!r || !r.author?.login || r.state === 'PENDING') continue
    reviews.push({
      user: r.author.login,
      avatarUrl: r.author.avatarUrl || '',
      state: r.state,
      body: r.body || '',
      submittedAt: r.submittedAt,
      htmlUrl: r.url
    })
  }
  const latestByUser = new Map<string, PRReview['state']>()
  for (const r of reviews) latestByUser.set(r.user, r.state)
  const latestStates = [...latestByUser.values()]
  let reviewDecision: PRStatus['reviewDecision'] = 'none'
  if (latestStates.some((s) => s === 'CHANGES_REQUESTED')) reviewDecision = 'changes_requested'
  else if (latestStates.some((s) => s === 'APPROVED')) reviewDecision = 'approved'
  else if (latestStates.length > 0) reviewDecision = 'review_required'

  let state: PRStatus['state']
  if (pr.state === 'MERGED') state = 'merged'
  else if (pr.state === 'CLOSED') state = 'closed'
  else if (pr.isDraft) state = 'draft'
  else state = 'open'

  let hasConflict: boolean | null
  if (pr.mergeable === 'CONFLICTING') hasConflict = true
  else if (pr.mergeable === 'MERGEABLE') hasConflict = false
  else hasConflict = null

  const assignees = (pr.assignees?.nodes ?? [])
    .filter((a): a is GraphQLActor => !!a?.login)
    .map((a) => ({ login: a.login!, avatarUrl: a.avatarUrl ?? '' }))

  const labels = (pr.labels?.nodes ?? [])
    .filter((l): l is { name: string; color: string; description: string | null } => !!l)
    .map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? undefined
    }))

  const linkedIssues = (pr.closingIssuesReferences?.nodes ?? [])
    .filter((n): n is { number: number; title: string; state: 'OPEN' | 'CLOSED'; url: string } => !!n)
    .map((n) => ({
      number: n.number,
      title: n.title,
      state: n.state === 'CLOSED' ? ('closed' as const) : ('open' as const),
      url: n.url
    }))

  const queuePosition = pr.mergeQueueEntry?.position
  const defaultBranch = pr.baseRepository?.defaultBranchRef?.name ?? ''

  return {
    number: pr.number,
    title: pr.title,
    state,
    url: pr.url,
    branch: branchName,
    author: pr.author?.login ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl ?? '' } : null,
    checks,
    checksOverall: computeOverall(checks),
    hasConflict,
    reviews,
    reviewDecision,
    additions: pr.additions,
    deletions: pr.deletions,
    baseBranch: pr.baseRefName,
    isDefaultBase: pr.baseRefName === defaultBranch,
    milestone: pr.milestone
      ? {
          title: pr.milestone.title,
          url: pr.milestone.url,
          state: pr.milestone.state === 'CLOSED' ? 'closed' : 'open'
        }
      : null,
    assignees,
    queuePosition: typeof queuePosition === 'number' && queuePosition > 0 ? queuePosition : undefined,
    queueEstimatedSeconds:
      typeof pr.mergeQueueEntry?.estimatedTimeToMerge === 'number'
        ? pr.mergeQueueEntry.estimatedTimeToMerge
        : undefined,
    behindBy: behindBy ?? undefined,
    linkedIssues,
    labels,
    firstReleaseTag: firstReleaseTag ?? undefined,
    hasMilestones
  }
}

/** Fetch one PR by number from the upstream repo and build a PRStatus.
 *  Used as a fallback by the poller: when the per-branch GraphQL lookup
 *  comes back empty for a worktree that previously had a known PR (most
 *  commonly because the PR merged and its head branch was deleted on
 *  GitHub), we replay the lookup by number so the status survives the
 *  transition instead of bouncing through "Active". */
export async function fetchPRStatusByNumber(
  ctx: RepoContext,
  prNumber: number,
  worktreePath: string,
  branchName: string
): Promise<PRStatus | null> {
  const token = getCachedToken()
  if (!token) return null
  const { owner, repo } = ctx.upstream
  const query = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    milestones(first: 1) { totalCount }
    pullRequest(number: $number) { ...PR }
  }
}
${PR_FRAGMENT}`
  const res = await trackedFetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Harness',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { owner, name: repo, number: prNumber } })
  })
  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as {
    data?: {
      repository?: {
        defaultBranchRef: { name: string } | null
        milestones: { totalCount: number } | null
        pullRequest: GraphQLPR | null
      } | null
    } | null
    errors?: Array<{ message: string }> | null
  }
  if (json.errors && json.errors.length > 0) {
    log('github', `GraphQL errors for ${owner}/${repo}#${prNumber}`, json.errors.map((e) => e.message).join('; '))
  }
  const pr = json.data?.repository?.pullRequest
  if (!pr) return null
  const hasMilestones = (json.data?.repository?.milestones?.totalCount ?? 0) > 0
  const firstReleaseTag =
    pr.state === 'MERGED' && pr.mergeCommit?.oid
      ? await getFirstTagContaining(worktreePath, pr.mergeCommit.oid)
      : null
  return buildPRStatus(pr, branchName, null, firstReleaseTag, hasMilestones)
}

/** Submit an APPROVE review on a PR with no comment body. Mirrors
 *  GitHub's "Approve without comment" — an empty body is fine when the
 *  `event` is APPROVE. */
export async function approvePR(
  repoRoot: string,
  prNumber: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getRepoContext(repoRoot)
  if (!ctx) return { ok: false, error: 'No GitHub origin remote detected' }
  const token = getCachedToken()
  if (!token) return { ok: false, error: 'No GitHub token configured' }
  const { owner, repo } = ctx.upstream
  try {
    const res = await trackedFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Harness',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ event: 'APPROVE' })
      }
    )
    if (res.status === 200 || res.status === 201) return { ok: true }
    let apiMessage = ''
    try {
      const data = (await res.json()) as { message?: string }
      apiMessage = data?.message || ''
    } catch {
      // ignore — fall through to status text
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Unauthorized — check that your token has repo scope' }
    }
    if (res.status === 422) {
      // Most common 422 here is "Can not approve your own pull request",
      // which the UI should filter out before calling. Surface GitHub's
      // message so unexpected cases aren't silent.
      return { ok: false, error: apiMessage || 'PR cannot be approved' }
    }
    return { ok: false, error: apiMessage || `${res.status} ${res.statusText}` }
  } catch (err) {
    log('github', `approvePR fetch failed for ${owner}/${repo}#${prNumber}`, formatErr(err))
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
    draft: pr.draft,
    requestedReviewers: [],
    reviewerStates: [],
    labels: []
  }
}

interface GraphQLListPR {
  number: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string
  baseRefName: string
  headRefName: string
  headRefOid: string
  author: GraphQLActor | null
  baseRepository: { nameWithOwner: string } | null
  headRepository: { nameWithOwner: string } | null
  reviewRequests: {
    nodes: Array<{
      requestedReviewer:
        | { __typename: 'User'; login: string; avatarUrl: string }
        | { __typename?: string }
        | null
    } | null> | null
  } | null
  reviews: {
    nodes: Array<{
      author: GraphQLActor | null
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
      submittedAt: string
    } | null> | null
  } | null
  labels: { nodes: Array<{ name: string; color: string } | null> | null } | null
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS' } | null
      }
    } | null> | null
  } | null
}

type GraphQLRollupState = 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS'

function rollupToOverall(state: GraphQLRollupState): NonNullable<PRSummary['checksOverall']> {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
  }
}

function buildPRSummaryFromGraphQL(pr: GraphQLListPR, upstreamFull: string): PRSummary {
  const headFull = pr.headRepository?.nameWithOwner ?? null
  const baseFull = pr.baseRepository?.nameWithOwner ?? upstreamFull
  const isFork = !!headFull && !!baseFull && headFull !== baseFull

  const requestedReviewers: PRSummary['requestedReviewers'] = []
  for (const node of pr.reviewRequests?.nodes ?? []) {
    const r = node?.requestedReviewer
    if (r && (r as { __typename?: string }).__typename === 'User') {
      const u = r as { login: string; avatarUrl: string }
      requestedReviewers.push({ login: u.login, avatarUrl: u.avatarUrl })
    }
  }

  // Dedupe to the latest non-PENDING/DISMISSED review per reviewer.
  const latestByUser = new Map<
    string,
    { login: string; avatarUrl: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; submittedAt: string }
  >()
  for (const r of pr.reviews?.nodes ?? []) {
    if (!r?.author?.login) continue
    if (r.state === 'PENDING' || r.state === 'DISMISSED') continue
    const prev = latestByUser.get(r.author.login)
    if (!prev || r.submittedAt > prev.submittedAt) {
      latestByUser.set(r.author.login, {
        login: r.author.login,
        avatarUrl: r.author.avatarUrl ?? '',
        state: r.state,
        submittedAt: r.submittedAt
      })
    }
  }
  const reviewerStates = [...latestByUser.values()].map(({ login, avatarUrl, state }) => ({
    login,
    avatarUrl,
    state
  }))

  const labels = (pr.labels?.nodes ?? [])
    .filter((l): l is { name: string; color: string } => !!l)
    .map((l) => ({ name: l.name, color: l.color }))

  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
  const checksOverall = rollup ? rollupToOverall(rollup) : undefined

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author?.login
      ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl ?? '' }
      : null,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    headSha: pr.headRefOid,
    headRepoFullName: headFull,
    isFork,
    updatedAt: pr.updatedAt,
    url: pr.url,
    draft: pr.isDraft,
    requestedReviewers,
    reviewerStates,
    labels,
    checksOverall
  }
}

/** List the most recently updated open PRs for the given local repo.
 *  Returns null on auth/network failure so callers can show a graceful
 *  empty/error state. Capped at 50 to keep the modal fast.
 *
 *  Uses GraphQL so reviewer avatars, label colors, and checks rollup
 *  come back in a single round trip — the REST /pulls list only
 *  returns requested-reviewer logins (no review state) and skips
 *  rollup entirely. */
export async function listOpenPRs(repoRoot: string): Promise<PRSummary[] | null> {
  const ctx = await getRepoContext(repoRoot)
  if (!ctx) return null
  const token = getCachedToken()
  if (!token) return null
  const { owner, repo } = ctx.upstream
  const upstreamFull = `${owner}/${repo}`
  const query = `query($owner:String!, $name:String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        baseRefName
        headRefName
        headRefOid
        author { login avatarUrl }
        baseRepository { nameWithOwner }
        headRepository { nameWithOwner }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login avatarUrl }
            }
          }
        }
        reviews(last: 100) {
          nodes {
            author { login avatarUrl }
            state
            submittedAt
          }
        }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
}`
  try {
    const res = await trackedFetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Harness',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables: { owner, name: repo } })
    })
    if (!res.ok) {
      throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as {
      data?: {
        repository?: {
          pullRequests?: { nodes?: Array<GraphQLListPR | null> | null } | null
        } | null
      } | null
      errors?: Array<{ message: string }> | null
    }
    if (json.errors && json.errors.length > 0) {
      log('github', `listOpenPRs GraphQL errors for ${upstreamFull}`, json.errors.map((e) => e.message).join('; '))
    }
    const nodes = json.data?.repository?.pullRequests?.nodes ?? []
    return nodes
      .filter((n): n is GraphQLListPR => !!n)
      .map((n) => buildPRSummaryFromGraphQL(n, upstreamFull))
  } catch (err) {
    log('github', `listOpenPRs failed for ${upstreamFull}`, formatErr(err))
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

// --- Review sync -----------------------------------------------------------

async function ghRequest(
  token: string,
  url: string,
  method: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Harness',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await trackedFetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, json }
}

async function ghGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const res = await trackedFetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Harness',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] }
  if (json.errors && json.errors.length > 0) {
    return { ok: false, data: json.data, error: json.errors.map((e) => e.message).join('; ') }
  }
  return { ok: true, data: json.data }
}

/** Push local review comments (as a DRAFT/pending review) + per-file viewed
 *  state to a GitHub PR, then pull the canonical comment set back.
 *
 *  Comments are added to the viewer's pending review so they stay unpublished
 *  until the user submits the review on GitHub. A user can only have one
 *  pending review per PR, so we reuse an existing one (adding threads to it)
 *  or create a fresh one. Line comments use the RIGHT side; file-level
 *  (line 0) comments aren't supported as drafts and are left local.
 *
 *  Best-effort: a comment GitHub rejects (e.g. a line outside the diff) is
 *  counted as failed and kept locally rather than aborting the sync.
 *  Comments already carrying a remoteId are assumed pushed and not re-sent. */
export async function syncPRReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  input: ReviewSyncInput
): Promise<ReviewSyncResult> {
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
  const passthrough = {
    comments: input.comments,
    reviewedFiles: input.reviewedFiles,
    pushed: 0,
    failed: 0
  }

  // 1. PR node id (for the draft-review + viewed-state GraphQL APIs).
  let nodeId = ''
  try {
    const pr = await ghRequest(token, base, 'GET')
    if (!pr.ok) {
      return { ok: false, error: `Could not load PR #${prNumber} (HTTP ${pr.status})`, ...passthrough }
    }
    nodeId = (pr.json as { node_id?: string }).node_id ?? ''
  } catch (err) {
    return { ok: false, error: formatErr(err), ...passthrough }
  }
  if (!nodeId) return { ok: false, error: 'Could not resolve PR node id', ...passthrough }

  // 2. Find the viewer's existing pending review, if any. Pending reviews are
  //    only returned to their author, so any PENDING entry here is ours.
  let pendingReviewNodeId = ''
  try {
    const res = await ghRequest(token, `${base}/reviews?per_page=100`, 'GET')
    if (res.ok && Array.isArray(res.json)) {
      const pending = (res.json as Array<{ id: number; node_id: string; state: string }>).find(
        (r) => r.state === 'PENDING'
      )
      if (pending) {
        pendingReviewNodeId = pending.node_id
      }
    }
  } catch (err) {
    log('github', 'list reviews failed', formatErr(err))
  }

  // 3. Push un-synced line comments as drafts on the pending review.
  const toPush = input.pullOnly
    ? []
    : input.comments.filter((c) => c.remoteId === undefined && c.lineNumber > 0)
  let pushed = 0
  let failed = 0
  if (toPush.length > 0) {
    if (pendingReviewNodeId) {
      // Existing pending review — add each comment as a thread.
      for (const c of toPush) {
        const r = await ghGraphQL(
          token,
          `mutation($rid:ID!,$path:String!,$line:Int!,$body:String!){
             addPullRequestReviewThread(input:{pullRequestReviewId:$rid,path:$path,line:$line,side:RIGHT,body:$body}){ thread { id } }
           }`,
          { rid: pendingReviewNodeId, path: c.filePath, line: c.lineNumber, body: c.body }
        )
        if (r.ok) pushed++
        else {
          failed++
          log('github', `draft thread rejected ${c.filePath}:${c.lineNumber}: ${r.error}`)
        }
      }
    } else {
      // No pending review yet — create one carrying all the threads.
      const threads = toPush.map((c) => ({
        path: c.filePath,
        line: c.lineNumber,
        side: 'RIGHT',
        body: c.body
      }))
      const r = await ghGraphQL(
        token,
        `mutation($prId:ID!,$threads:[DraftPullRequestReviewThread!]){
           addPullRequestReview(input:{pullRequestId:$prId,threads:$threads}){ pullRequestReview { databaseId } }
         }`,
        { prId: nodeId, threads }
      )
      if (r.ok) {
        pushed += toPush.length
      } else {
        failed += toPush.length
        log('github', `create draft review failed: ${r.error}`)
      }
    }
  }

  // 4. Push viewed state — only MARK locally-reviewed files. Never unmark:
  //    a file viewed on GitHub (but not locally) must not get cleared.
  //    Skipped on a pull-only sync.
  const reviewedSet = new Set(input.reviewedFiles)
  if (!input.pullOnly) {
    for (const path of input.files) {
      if (!reviewedSet.has(path)) continue
      const r = await ghGraphQL(
        token,
        'mutation($id:ID!,$p:String!){markFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}',
        { id: nodeId, p: path }
      )
      if (!r.ok) log('github', `mark viewed failed for ${path}: ${r.error}`)
    }
  }

  // 4b. Pull GitHub's viewed state and union it with the local set, so files
  //     viewed on GitHub stay viewed (and vice-versa). Viewed state is
  //     additive — un-viewing isn't propagated.
  const ghViewed = new Set<string>()
  const viewedQuery = await ghGraphQL(
    token,
    'query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){files(first:100){nodes{path viewerViewedState}}}}}',
    { o: owner, n: repo, num: prNumber }
  )
  if (viewedQuery.ok) {
    const nodes =
      (
        viewedQuery.data as {
          repository?: {
            pullRequest?: { files?: { nodes?: Array<{ path: string; viewerViewedState?: string }> } }
          }
        }
      )?.repository?.pullRequest?.files?.nodes ?? []
    for (const f of nodes) if (f.viewerViewedState === 'VIEWED') ghViewed.add(f.path)
  } else {
    log('github', `viewed-state query failed: ${viewedQuery.error}`)
  }
  const mergedReviewed = [...new Set([...input.reviewedFiles, ...ghViewed])]

  // 5. Pull the canonical comment set: published comments + our pending
  //    review's drafts (so freshly-pushed drafts get an id and don't re-post).
  const pulled: ReviewSyncComment[] = []
  type ApiComment = {
    id: number
    path: string
    line?: number | null
    original_line?: number | null
    body?: string
    created_at?: string
    html_url?: string
    in_reply_to_id?: number
    user?: { login?: string; avatar_url?: string }
  }
  const collect = (arr: ApiComment[]): void => {
    for (const rc of arr) {
      pulled.push({
        filePath: rc.path,
        lineNumber: rc.line ?? rc.original_line ?? 0,
        body: rc.body ?? '',
        remoteId: rc.id,
        author: rc.user?.login,
        authorAvatarUrl: rc.user?.avatar_url,
        createdAt: rc.created_at,
        htmlUrl: rc.html_url,
        draft: false,
        inReplyToId: rc.in_reply_to_id
      })
    }
  }
  try {
    const published = await ghRequest(token, `${base}/comments?per_page=100`, 'GET')
    if (published.ok && Array.isArray(published.json)) collect(published.json as ApiComment[])
  } catch (err) {
    log('github', 'list review comments error', formatErr(err))
  }
  // Pending (draft) review comments come back from REST with a null line, so
  // pull them via GraphQL where originalLine is populated.
  const draftQuery = await ghGraphQL(
    token,
    'query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviews(first:20,states:[PENDING]){nodes{comments(first:100){nodes{databaseId path line originalLine body createdAt url replyTo{databaseId} author{login avatarUrl}}}}}}}}',
    { o: owner, n: repo, num: prNumber }
  )
  if (draftQuery.ok) {
    type GqlComment = {
      databaseId?: number
      path?: string
      line?: number | null
      originalLine?: number | null
      body?: string
      createdAt?: string
      url?: string
      replyTo?: { databaseId?: number }
      author?: { login?: string; avatarUrl?: string }
    }
    const reviews =
      (
        draftQuery.data as {
          repository?: {
            pullRequest?: { reviews?: { nodes?: Array<{ comments?: { nodes?: GqlComment[] } }> } }
          }
        }
      )?.repository?.pullRequest?.reviews?.nodes ?? []
    for (const rev of reviews) {
      for (const c of rev?.comments?.nodes ?? []) {
        if (typeof c.databaseId !== 'number' || !c.path) continue
        pulled.push({
          filePath: c.path,
          lineNumber: c.line ?? c.originalLine ?? 0,
          body: c.body ?? '',
          remoteId: c.databaseId,
          author: c.author?.login,
          authorAvatarUrl: c.author?.avatarUrl,
          createdAt: c.createdAt,
          htmlUrl: c.url,
          draft: true,
          inReplyToId: c.replyTo?.databaseId
        })
      }
    }
  } else {
    log('github', `pending review comments query failed: ${draftQuery.error}`)
  }

  // Drafts pulled from a pending review can come back with a null/0 line.
  // Recover it from the matching local comment (same file + body) so the
  // pulled copy renders at the right line AND dedupes against the local one
  // — otherwise it lands at the top and the local copy is kept too.
  for (const p of pulled) {
    if (p.lineNumber === 0) {
      const local = input.comments.find(
        (c) => c.filePath === p.filePath && c.body === p.body && c.lineNumber > 0
      )
      if (local) p.lineNumber = local.lineNumber
    }
  }

  // Collapse identical duplicates (e.g. drafts accidentally pushed twice by
  // earlier syncs) so they don't pile up. Keyed on file+line+body+author so
  // distinct reviewers' identical text isn't merged.
  const seen = new Set<string>()
  const dedupedPulled = pulled.filter((c) => {
    const k = `${c.filePath}:${c.lineNumber}:${c.body}:${c.author ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Keep local comments not represented in the pulled set — file-level
  // comments (no draft support) and any that failed to push — so they're
  // not lost and can retry next sync.
  const pulledKey = new Set(dedupedPulled.map((c) => `${c.filePath}:${c.lineNumber}:${c.body}`))
  const keptLocal = input.comments.filter(
    (c) => c.remoteId === undefined && !pulledKey.has(`${c.filePath}:${c.lineNumber}:${c.body}`)
  )

  return {
    ok: true,
    comments: [...dedupedPulled, ...keptLocal],
    reviewedFiles: mergedReviewed,
    pushed,
    failed
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
