// SPIKE — throwaway. Not wired into main/index.ts.
//
// Validates the GitHub search endpoint we'd use to power a "PRs awaiting
// your review" surface. Run via a temporary `void fetchReviewRequests()`
// call from main/index.ts during dev, or import from a unit test.
//
// Findings (probed live against api.github.com on 2026-04-14):
//   - Endpoint: GET /search/issues?q=is:pr+is:open+review-requested:@me
//   - Auth: works with a classic PAT carrying `repo` + `read:org`
//     (also works with the gh-CLI token resolved by github-auth.ts)
//   - Rate limit: 30 req/min on the *search* resource pool — independent
//     from the 5000/hr core pool that PRPoller hits, so there's no
//     contention with existing per-worktree polling.
//   - Response includes: number, title, html_url, repository_url, user,
//     state, draft, created_at, updated_at, pull_request.{merged_at,...}
//     — enough for a list view with title + repo + age.
//   - Does NOT include: check status, mergeability, review decision.
//     A v1 list-only surface doesn't need them; if we want badges we'd
//     follow up per-PR via /repos/{owner}/{repo}/pulls/{n} (core pool).
//   - Authored-by-self filter: combine with `-author:@me` in the query
//     so the user's own PRs don't show up.
//   - Cross-org / private repos: returned automatically as long as the
//     token has access. GitHub Enterprise Server would need a different
//     base URL — out of scope for v1.

import { getCachedToken, resolveGitHubToken } from './github-auth'
import { log } from './debug'

export interface ReviewRequest {
  number: number
  title: string
  htmlUrl: string
  repoFullName: string // "owner/repo"
  author: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
}

interface SearchItem {
  number: number
  title: string
  html_url: string
  repository_url: string // "https://api.github.com/repos/owner/repo"
  user: { login: string }
  draft?: boolean
  created_at: string
  updated_at: string
}

interface SearchResponse {
  total_count: number
  incomplete_results: boolean
  items: SearchItem[]
}

function repoFullNameFromUrl(repositoryUrl: string): string {
  // "https://api.github.com/repos/owner/repo" → "owner/repo"
  const idx = repositoryUrl.indexOf('/repos/')
  return idx >= 0 ? repositoryUrl.slice(idx + '/repos/'.length) : repositoryUrl
}

export async function fetchReviewRequests(): Promise<ReviewRequest[]> {
  let token = getCachedToken()
  if (!token) {
    const resolved = await resolveGitHubToken()
    token = resolved?.token ?? null
  }
  if (!token) {
    log('reviews-spike', 'no token available')
    return []
  }

  // -author:@me excludes the user's own PRs (they can't review themselves).
  // archived:false drops PRs in archived repos which would be noise.
  const q = encodeURIComponent('is:pr is:open review-requested:@me -author:@me archived:false')
  const url = `https://api.github.com/search/issues?q=${q}&per_page=50&sort=updated&order=desc`

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Harness',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`
    }
  })

  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  log('reviews-spike', `status=${res.status} search-remaining=${remaining} reset=${reset}`)

  if (!res.ok) {
    log('reviews-spike', `error ${res.status} ${res.statusText}`)
    return []
  }

  const data = (await res.json()) as SearchResponse
  log('reviews-spike', `total_count=${data.total_count} returned=${data.items.length}`)

  return data.items.map((item) => ({
    number: item.number,
    title: item.title,
    htmlUrl: item.html_url,
    repoFullName: repoFullNameFromUrl(item.repository_url),
    author: item.user.login,
    isDraft: item.draft === true,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  }))
}
