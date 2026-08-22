import type { PRStatus } from '../shared/state/prs'
import { wrapAutomatedMessage } from '../shared/state/json-claude'

/** Compose the message injected into the agent chat when the user asks for
 *  help with a conflicted PR. Unlike CI failures this is never automatic:
 *  a branch that conflicts with its base usually conflicts with every other
 *  in-flight branch too, so auto-firing would cascade agents across the
 *  whole workspace over one bad merge base.
 *
 *  Deliberately doesn't enumerate the conflicted files. The local base ref
 *  is often stale, so a `git merge-tree` preview from here would name files
 *  the agent then finds clean — it has git and can see the real answer.
 *
 *  Names no strategy for the same reason: rebase-vs-merge is a per-repo
 *  convention the agent can read off `git log` and CLAUDE.md, and Ness has
 *  no setting that records it (`mergeStrategy` is how a PR lands on main,
 *  which says nothing about how a branch syncs with its base). */
export function buildMergeConflictMessage(pr: PRStatus): string {
  const body = [
    `PR #${pr.number} (${pr.branch}) has merge conflicts with ${pr.baseBranch}. Please resolve them.`,
    '',
    `Bring the branch up to date with the latest ${pr.baseBranch} — rebase or merge, whichever matches this repo's convention — and resolve each conflict. Verify the build still passes, then push so the PR updates (force-with-lease if you rebased).`,
    '',
    pr.url
  ].join('\n')
  return wrapAutomatedMessage('merge-conflict', body)
}
