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

export function displayLabel(
  worktree: Worktree,
  alias: string | undefined,
  metaHeld: boolean
): string {
  // Cmd-held reveals the path behind an alias — only for aliased rows.
  // Non-aliased rows already show the branch; revealing the path would
  // just be noise.
  if (metaHeld && alias) {
    const base = worktreesRoot(worktree.repoRoot)
    if (worktree.path.startsWith(base + '/')) {
      return worktree.path.slice(base.length + 1)
    }
    return worktree.path
  }
  return alias ?? worktree.branch
}
