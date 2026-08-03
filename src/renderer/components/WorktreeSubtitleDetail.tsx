import { Fragment, type ReactNode } from 'react'
import type { Worktree, PRStatus, SidebarDetailPrefs } from '../types'
import { formatWorktreeAge } from './worktree-detail'
import { repoNameColor } from './RepoIcon'

interface SubtitleDetailProps {
  worktree: Worktree
  repoLabel?: string
  aliased: boolean
  prStatus?: PRStatus | null
  prefs: SidebarDetailPrefs
  /** When true, render as a top-row-inline cluster (compact density):
   *  container is `shrink-0` so the label truncates first, and long items
   *  (repoLabel / branch / milestone) hide on hover to make room for the
   *  action buttons. When false (default), renders as a stacked line-2
   *  cluster that grows into `flex-1 min-w-0` next to the label. */
  inline?: boolean
}

/** The right-hand / line-2 detail cluster shown next to each sidebar
 *  worktree row. Shared between `WorktreeTab` (production use) and the
 *  Settings > Appearance > Sidebar preview so both stay in sync when the
 *  layout or item set changes. */
export function SubtitleDetail({ worktree, repoLabel, aliased, prStatus, prefs, inline }: SubtitleDetailProps): JSX.Element | null {
  const items: { key: string; node: ReactNode }[] = []
  if (repoLabel && prefs.repoLabel) {
    items.push({
      key: 'repo',
      node: (
        <span
          className={`${repoNameColor(repoLabel)} truncate min-w-0 max-w-[5rem]${inline ? ' group-hover:hidden' : ''}`}
        >
          {repoLabel}
        </span>
      )
    })
  }
  if (aliased && prefs.branch) {
    items.push({
      key: 'branch',
      node: (
        <span
          className={`truncate min-w-0 max-w-[8rem]${inline ? ' group-hover:hidden' : ''}`}
          title={worktree.branch}
        >
          {worktree.branch}
        </span>
      )
    })
  }
  if (worktree.createdAt && prefs.age) {
    items.push({
      key: 'age',
      node: (
        <span
          className="font-mono shrink-0"
          title={`Created ${new Date(worktree.createdAt).toLocaleString()}`}
        >
          {formatWorktreeAge(worktree.createdAt)}
        </span>
      )
    })
  }
  if (prefs.diff && prStatus && typeof prStatus.additions === 'number' && typeof prStatus.deletions === 'number') {
    items.push({
      key: 'diff',
      node: (
        <span
          className={`font-mono shrink-0${inline ? ' group-hover:hidden' : ''}`}
          title={`+${prStatus.additions} additions, −${prStatus.deletions} deletions`}
        >
          <span className="text-success">+{prStatus.additions}</span>
          <span className="text-danger ml-0.5">−{prStatus.deletions}</span>
        </span>
      )
    })
  }
  if (prefs.milestone && prStatus?.milestone) {
    items.push({
      key: 'milestone',
      node: (
        <span
          className={`truncate min-w-0 max-w-[6rem]${inline ? ' group-hover:hidden' : ''}`}
          title={`Milestone: ${prStatus.milestone.title}`}
        >
          {prStatus.milestone.title}
        </span>
      )
    })
  }
  if (prefs.prNumber && prStatus) {
    items.push({
      key: 'num',
      node: (
        <span
          className="font-mono shrink-0 px-1.5 py-0.5 rounded-full bg-panel border border-border-strong text-fg-bright leading-none"
          title={`PR #${prStatus.number}`}
        >
          #{prStatus.number}
        </span>
      )
    })
  }
  if (prefs.assignee && prStatus?.assignees[0]) {
    const assignee = prStatus.assignees[0]
    items.push({
      key: 'assignee',
      node: (
        <img
          src={assignee.avatarUrl}
          alt=""
          title={`Assignee: ${assignee.login}${prStatus.assignees.length > 1 ? ` (+${prStatus.assignees.length - 1})` : ''}`}
          className="w-3.5 h-3.5 rounded-full shrink-0"
        />
      )
    })
  }
  if (items.length === 0) return null
  return (
    <div
      className={
        inline
          ? 'text-xs text-faint flex items-center gap-1 shrink-0 min-w-0'
          : 'text-xs text-faint flex items-center gap-1 min-w-0'
      }
    >
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && (
            <span
              className={`text-dim shrink-0${inline && (item.key === 'branch' || item.key === 'age') ? ' group-hover:hidden' : ''}`}
            >
              ·
            </span>
          )}
          {item.node}
        </Fragment>
      ))}
    </div>
  )
}
