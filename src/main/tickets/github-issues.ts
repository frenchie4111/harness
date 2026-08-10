// GitHub Issues provider.
//
// Why this is small: Claude already has the gh CLI at runtime, so the
// ticket-picker only needs enough to render a list and seed a kickoff
// prompt. Labels, assignees, comments, state transitions — Claude
// reaches for those directly via gh once a worktree is spawned. See
// src/shared/tickets.ts for the contract.

import { log, formatErr } from '../debug'
import {
  getCachedToken,
  invalidateTokenCache,
  resolveGitHubToken
} from '../github-auth'
import { trackedFetch } from '../github-recorder'
import type {
  GithubIssuesConfig,
  Ticket,
  TicketProvider
} from '../../shared/tickets'

interface ApiIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  state: string
  pull_request?: unknown
}

function parseRepo(repo: string): { owner: string; repo: string } | null {
  const trimmed = repo.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  return {
    owner: trimmed.slice(0, slash),
    repo: trimmed.slice(slash + 1)
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

async function githubFetch(url: string): Promise<unknown> {
  let token = getCachedToken()
  let res = await doFetch(url, token)
  if (res.status === 401) {
    log('tickets-github', '401 from GitHub, re-resolving token')
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

function toTicket(providerId: string, issue: ApiIssue): Ticket {
  return {
    id: `${providerId}:${issue.number}`,
    providerId,
    externalId: String(issue.number),
    title: issue.title,
    description: issue.body ?? '',
    url: issue.html_url,
    // GitHub Issues has exactly two states — pass them through verbatim so
    // the Tickets view's raw-status bucketing renders "open" / "closed"
    // as user-visible bucket headers.
    status: issue.state || undefined
  }
}

export function createGithubIssuesProvider(
  providerId: string,
  config: GithubIssuesConfig
): TicketProvider {
  const parsed = parseRepo(config.repo)
  if (!parsed) {
    throw new Error(
      `github-issues provider: invalid repo "${config.repo}" (expected "owner/repo")`
    )
  }
  const { owner, repo } = parsed

  return {
    async list(query) {
      // Use /search/issues unconditionally — the REST /repos/*/issues
      // endpoint returns both issues AND PRs, so on repos with heavy PR
      // activity the first N results are almost all PRs and by the time
      // we filter them out the user is left with a handful of issues.
      // Search filters PRs out server-side via `is:issue`, so every
      // returned slot is a real issue. Rate limits are lower (30/min
      // for authed vs. 5000/hr for REST) but ticket listings are
      // infrequent enough that this doesn't matter.
      //
      // No `state:open` filter — we want the "closed" bucket in the
      // Tickets view to populate too. Search defaults to relevance
      // when no sort is given; specify `updated` desc so freshest
      // activity bubbles to the top and stays consistent with the
      // REST path's ordering.
      const q = (query ?? config.defaultQuery ?? '').trim()
      const filterParts = ['is:issue', `repo:${owner}/${repo}`]
      if (q) filterParts.unshift(q)
      const search = filterParts.join(' ')
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(search)}&per_page=100&sort=updated&order=desc`
      try {
        const data = await githubFetch(url)
        const items: ApiIssue[] = (data as { items?: ApiIssue[] } | null)?.items ?? []
        return items
          .filter((i) => !i.pull_request)
          .map((i) => toTicket(providerId, i))
      } catch (err) {
        log('tickets-github', `list failed for ${owner}/${repo}`, formatErr(err))
        throw err
      }
    },

    async get(externalId) {
      const n = Number.parseInt(externalId, 10)
      if (!Number.isFinite(n) || n <= 0) return null
      try {
        const data = (await githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${n}`
        )) as ApiIssue
        if (!data || typeof data.number !== 'number') return null
        if (data.pull_request) return null
        return toTicket(providerId, data)
      } catch (err) {
        log('tickets-github', `get failed for ${owner}/${repo}#${n}`, formatErr(err))
        return null
      }
    }
  }
}
