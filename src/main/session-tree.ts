import type { DiscoveredSession } from './session-scanner'

/** Groups scanned sessions into the repo → branch → sessions shape the import
 *  browser renders.
 *
 *  Nothing is dropped here, deliberately. An earlier cut of this filtered out
 *  sessions whose cwd was '/' or a sandbox path — 79% of a real corpus — on
 *  the grounds that they aren't work anyone wants to import. But a filter the
 *  user can't see is a filter they can't correct, and "my session isn't in
 *  the list" is a worse failure than "there are a lot of rows". Grouping is
 *  what makes the volume tractable instead: a bucket of 6000 uninteresting
 *  sessions collapses to a single row nobody has to expand.
 *
 *  Ordering carries the weight that filtering would have. Buckets that
 *  resolve to a real repository sort above loose-location buckets, and
 *  everything sorts by recency within its band, so the rows worth seeing are
 *  at the top without anything becoming unreachable. */

export type SessionGroupKind = 'repo' | 'location' | 'temporary' | 'unknown'

/** Sandbox and scratch directories. Each one is typically a single session in
 *  a uniquely-named temp dir, so left alone they produce hundreds of
 *  singleton groups — on a real corpus, 440 of them. Coalescing them into one
 *  node keeps them reachable while costing a single row. */
const TEMPORARY_PATH_RE = /^(\/private)?\/(tmp|var\/folders)\//

const TEMPORARY_GROUP_KEY = '(temporary)'

export function isTemporaryPath(cwd: string): boolean {
  return TEMPORARY_PATH_RE.test(cwd)
}

export interface BranchNode {
  key: string
  branch: string | null
  sessions: DiscoveredSession[]
  sessionCount: number
  latestTimestamp: number
  prCount: number
}

export interface SessionGroupNode {
  key: string
  label: string
  kind: SessionGroupKind
  /** Resolved repository root, when one could be determined. */
  path: string | null
  branches: BranchNode[]
  sessionCount: number
  latestTimestamp: number
  prCount: number
}

/** Ness's worktree layout puts checkouts in a sibling directory named after
 *  the repo: `<repo>` and `<repo>-worktrees/<branch>`. Recovering the repo
 *  from a worktree path keeps every branch of one project in a single group
 *  instead of scattering it across one bucket per worktree. */
const WORKTREES_MARKER = '-worktrees/'

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export function resolveRepoRoot(cwd: string, repoRoots: string[]): string | null {
  const normalized = normalizePath(cwd)

  // Longest match wins so a nested repo doesn't get swallowed by its parent.
  let best: string | null = null
  for (const root of repoRoots) {
    const candidate = normalizePath(root)
    if (isUnder(normalized, candidate) && (best === null || candidate.length > best.length)) {
      best = candidate
    }
  }
  if (best) return best

  const markerAt = normalized.indexOf(WORKTREES_MARKER)
  if (markerAt !== -1) {
    const derived = normalized.slice(0, markerAt)
    if (derived) return derived
  }

  return null
}

function basename(path: string): string {
  const trimmed = normalizePath(path)
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed
}

function groupKindFor(cwd: string | null, repoRoot: string | null): SessionGroupKind {
  if (repoRoot) return 'repo'
  if (!cwd) return 'unknown'
  if (isTemporaryPath(cwd)) return 'temporary'
  return 'location'
}

/** Shorten `/Users/<me>/…` to `~/…` so a loose-location row reads as a path
 *  rather than filling the row with a home prefix every entry shares. */
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path
  const normalizedHome = normalizePath(home)
  if (path === normalizedHome) return '~'
  if (path.startsWith(`${normalizedHome}/`)) return `~${path.slice(normalizedHome.length)}`
  return path
}

function labelFor(
  kind: SessionGroupKind,
  cwd: string | null,
  repoRoot: string | null,
  home: string
): string {
  if (kind === 'repo' && repoRoot) return basename(repoRoot)
  if (kind === 'unknown') return 'Unknown location'
  if (kind === 'temporary') return 'Temporary locations'
  return abbreviateHome(cwd ?? '', home) || 'Unknown location'
}

function sessionTime(session: DiscoveredSession): number {
  return session.lastTimestamp ?? session.mtimeMs
}

interface MutableBranch {
  branch: string | null
  sessions: DiscoveredSession[]
}

interface MutableGroup {
  key: string
  label: string
  kind: SessionGroupKind
  path: string | null
  branches: Map<string, MutableBranch>
}

export function buildSessionTree(
  sessions: DiscoveredSession[],
  repoRoots: string[] = [],
  home = ''
): SessionGroupNode[] {
  const groups = new Map<string, MutableGroup>()

  for (const session of sessions) {
    const repoRoot = session.cwd ? resolveRepoRoot(session.cwd, repoRoots) : null
    const kind = groupKindFor(session.cwd, repoRoot)
    const groupKey =
      kind === 'temporary' ? TEMPORARY_GROUP_KEY : (repoRoot ?? session.cwd ?? '(unknown)')

    let group = groups.get(groupKey)
    if (!group) {
      group = {
        key: groupKey,
        label: labelFor(kind, session.cwd, repoRoot, home),
        kind,
        path: kind === 'temporary' ? null : (repoRoot ?? session.cwd),
        branches: new Map()
      }
      groups.set(groupKey, group)
    }

    const branchKey = session.gitBranch ?? '(no branch)'
    let branch = group.branches.get(branchKey)
    if (!branch) {
      branch = { branch: session.gitBranch, sessions: [] }
      group.branches.set(branchKey, branch)
    }
    branch.sessions.push(session)
  }

  const nodes: SessionGroupNode[] = []
  for (const group of groups.values()) {
    const branches: BranchNode[] = []
    for (const [branchKey, branch] of group.branches) {
      const ordered = [...branch.sessions].sort((a, b) => sessionTime(b) - sessionTime(a))
      branches.push({
        key: `${group.key}::${branchKey}`,
        branch: branch.branch,
        sessions: ordered,
        sessionCount: ordered.length,
        latestTimestamp: ordered.length > 0 ? sessionTime(ordered[0]) : 0,
        prCount: ordered.filter((s) => s.prNumber !== null).length
      })
    }
    branches.sort((a, b) => b.latestTimestamp - a.latestTimestamp)

    nodes.push({
      key: group.key,
      label: group.label,
      kind: group.kind,
      path: group.path,
      branches,
      sessionCount: branches.reduce((n, b) => n + b.sessionCount, 0),
      latestTimestamp: branches.length > 0 ? branches[0].latestTimestamp : 0,
      prCount: branches.reduce((n, b) => n + b.prCount, 0)
    })
  }

  // Real repositories first, then loose locations, then unknowns — recency
  // within each band. Ordering, not exclusion: every bucket is still here.
  const bandOf = (kind: SessionGroupKind): number =>
    kind === 'repo' ? 0 : kind === 'location' ? 1 : kind === 'temporary' ? 2 : 3
  nodes.sort((a, b) => {
    const band = bandOf(a.kind) - bandOf(b.kind)
    if (band !== 0) return band
    return b.latestTimestamp - a.latestTimestamp
  })

  return nodes
}
