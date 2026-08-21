import type { DiscoveredSession } from '../shared/session-import-types'
import type { RepoImportCandidate, RepoImportPlan } from '../shared/repo-import-types'
import type { BranchInventoryEntry } from './worktree'
import { resolveRepoRoot } from './session-tree'

export type {
  ChatDepth,
  RepoImportBranchResult,
  RepoImportCandidate,
  RepoImportPlan,
  RepoImportRequest,
  RepoImportResult
} from '../shared/repo-import-types'

/** Turns "this repo has history on disk" into a checklist of branches worth
 *  recreating as Ness worktrees.
 *
 *  The question the picker asks is "which of these are you still working
 *  on?", and the honest answer comes from CHAT recency, not git. Measured on
 *  a real repo: 461 local branches, of which git could only prove 57 merged
 *  (the repo rebase-merges, so landed branches keep unreachable SHAs and
 *  read as live). Selecting on merge state would have pre-checked ~400
 *  branches. Chat recency cuts the same corpus to the couple of dozen the
 *  user actually touched this week, which is what they meant by the
 *  question.
 *
 *  Nothing is dropped for being old or merged — those rows are present and
 *  unchecked, per the same reasoning as session-tree.ts. The one genuine
 *  exclusion is a branch with no local ref, because there is no commit to
 *  check out; those are counted in `strandedSessionCount` so the total never
 *  silently shrinks. */

/** Chats touched inside this window pre-check their branch. A week is what
 *  separates "open loop" from "I remember doing that" for most people, and
 *  the picker exposes wider windows as one click. */
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed
}

function sessionTime(session: DiscoveredSession): number {
  return session.lastTimestamp ?? session.mtimeMs
}

export interface BuildPlanOptions {
  repoRoot: string
  sessions: DiscoveredSession[]
  inventory: BranchInventoryEntry[]
  now?: number
  activeWindowMs?: number
}

export function buildRepoImportPlan(options: BuildPlanOptions): RepoImportPlan {
  const { repoRoot, sessions, inventory } = options
  const now = options.now ?? Date.now()
  const activeWindowMs = options.activeWindowMs ?? ACTIVE_WINDOW_MS

  const byName = new Map(inventory.map((entry) => [entry.name, entry]))
  const grouped = new Map<string, DiscoveredSession[]>()
  let totalSessionCount = 0

  for (const session of sessions) {
    if (!session.cwd) continue
    if (resolveRepoRoot(session.cwd, [repoRoot]) !== repoRoot) continue
    totalSessionCount++
    if (!session.gitBranch) continue
    const existing = grouped.get(session.gitBranch)
    if (existing) existing.push(session)
    else grouped.set(session.gitBranch, [session])
  }

  const candidates: RepoImportCandidate[] = []
  let strandedSessionCount = 0

  for (const [branch, branchSessions] of grouped) {
    const entry = byName.get(branch)
    if (!entry) {
      // Branch was deleted after the work landed. The chats survive and stay
      // reachable through the session browser; they just can't be a worktree.
      strandedSessionCount += branchSessions.length
      continue
    }

    const ordered = [...branchSessions].sort((a, b) => sessionTime(b) - sessionTime(a))
    const latestActivityMs = sessionTime(ordered[0])
    const withPr = ordered.find((s) => s.prNumber !== null)

    candidates.push({
      branch,
      sessionIds: ordered.map((s) => s.sessionId),
      sessionCount: ordered.length,
      latestActivityMs,
      lastCommitMs: entry.lastCommitMs || null,
      merged: entry.merged,
      checkedOutAt: entry.checkedOutAt,
      hasLocalRef: true,
      prNumber: withPr?.prNumber ?? null,
      latestTitle: ordered[0].title,
      recommended:
        entry.checkedOutAt === null &&
        !entry.merged &&
        now - latestActivityMs <= activeWindowMs
    })
  }

  candidates.sort((a, b) => b.latestActivityMs - a.latestActivityMs)

  return {
    repoRoot,
    repoLabel: basename(repoRoot),
    candidates,
    strandedSessionCount,
    totalSessionCount,
    recommendedCount: candidates.filter((c) => c.recommended).length
  }
}
