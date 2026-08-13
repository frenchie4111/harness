import type { AppState } from '../shared/state'
import type { Worktree } from '../shared/state/worktrees'
import { getGroupKey, GROUP_LABELS } from '../shared/worktree-sort'
import type { WorktreeStatusInfo } from './control-server'

/** Describe a worktree the way the sidebar does — same grouping function, so
 *  an agent reading `list_worktrees` and a human reading the sidebar can't
 *  disagree about whether something is merged, blocked, or still in flight. */
export function deriveWorktreeStatus(
  state: AppState,
  wt: Worktree
): WorktreeStatusInfo {
  const pr = state.prs.byPath[wt.path]
  const status = getGroupKey(
    wt,
    pr,
    state.prs.mergedByPath[wt.path],
    !!state.snooze.byPath[wt.path],
    state.settings.viewerLogin
  )
  const alias = state.aliases.byPath[wt.path]
  return {
    ...(alias ? { alias } : {}),
    status,
    statusLabel: GROUP_LABELS[status],
    ...(pr
      ? {
          pr: {
            number: pr.number,
            state: pr.state,
            title: pr.title,
            checks: pr.checksOverall,
            reviewDecision: pr.reviewDecision,
            hasConflict: pr.hasConflict
          }
        }
      : {})
  }
}
