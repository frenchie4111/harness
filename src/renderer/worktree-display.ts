import type { Worktree } from '../shared/state/worktrees'

/** Standard worktrees root for a repo: `<repoParent>/<repoName>-worktrees/`.
 *  Mirrors `defaultWorktreeDir` in src/main/worktree.ts. Worktrees created at
 *  custom paths won't be under this base and won't get the relative-path
 *  reveal. */
function worktreesRoot(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return `${trimmed}-worktrees`
  const parent = trimmed.slice(0, slash)
  const repoName = trimmed.slice(slash + 1)
  return `${parent}/${repoName}-worktrees`
}

/** Single source of truth for "what text do we show for this worktree?"
 *  across every human-facing surface (sidebar row, tab strip, palette).
 *
 *  Resolution order:
 *    1. If Cmd is held AND an `alias` is present → reveal the worktree's
 *       path relative to the standard worktrees root; falls back to the
 *       absolute path for worktrees at non-standard locations. This is
 *       the "peek behind the alias" affordance — non-aliased rows never
 *       change under Cmd, since they already show the branch.
 *    2. Otherwise, the `alias` if defined.
 *    3. Otherwise, `worktree.branch`.
 *
 *  Machine-facing surfaces (git commands, PR merge headers, API URLs)
 *  MUST NOT use this helper — they need the real branch. Callers pass
 *  the alias string, not the whole aliases map, so per-id subscription
 *  hooks (`useAliasForPath`) can be used to avoid whole-slice re-render
 *  fan-out (CLAUDE.md anti-pattern #4). */
export function displayLabel(
  worktree: Worktree,
  alias: string | undefined,
  metaHeld: boolean
): string {
  if (metaHeld && alias) {
    const base = worktreesRoot(worktree.repoRoot)
    if (worktree.path.startsWith(base + '/')) {
      return worktree.path.slice(base.length + 1)
    }
    return worktree.path
  }
  return alias ?? worktree.branch
}

/** Resolves the sidebar row's subtitle (the small line under the display
 *  label). Returns null when there's nothing worth showing — callers should
 *  skip rendering the subtitle `<div>` entirely so it reclaims vertical
 *  space.
 *
 *  Rules:
 *  - Prunable worktrees always surface the on-disk path so the missing dir
 *    is identifiable — path.pop() when a repoLabel accompanies it,
 *    otherwise the last two segments.
 *  - Otherwise the branch is shown only when it differs from the resolved
 *    top-line `label` (i.e. only when an alias is set, or when Cmd is held
 *    on an aliased row and the top line is a path).
 *  - `repoLabel` is orthogonal cross-repo disambiguation and always shows
 *    when present. */
export function resolveSubtitle(
  worktree: Worktree,
  label: string,
  repoLabel: string | undefined
): { repoLabel: string | null; text: string | null } | null {
  if (worktree.prunable) {
    const text = repoLabel
      ? worktree.path.split('/').pop() ?? null
      : worktree.path.split('/').slice(-2).join('/')
    return { repoLabel: repoLabel ?? null, text }
  }
  const showBranch = worktree.branch !== label
  if (!repoLabel && !showBranch) return null
  return {
    repoLabel: repoLabel ?? null,
    text: showBranch ? worktree.branch : null
  }
}
