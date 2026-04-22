// Wire-format types for the weekly-wrapped summary. Shared so main (the
// computer) and renderer (the display) reference a single shape.

export interface TopWorktree {
  path: string
  branch: string
  repoLabel: string
  minutes: number
}

export interface WeeklyStats {
  /** Start of the window, epoch ms (now - 7d). */
  since: number
  /** End of the window, epoch ms (now). */
  until: number

  commits: number
  linesAdded: number
  linesRemoved: number
  prsMerged: number
  prsOpen: number
  worktreesCreated: number

  activeMinutes: number
  approvalsHandedOut: number

  busiestDay: { dayOfWeek: number; label: string; minutes: number } | null
  peakHour: { hour: number; label: string; minutes: number } | null

  topWorktrees: TopWorktree[]

  /** Per-day active minutes, oldest → newest (length 7). */
  dailyMinutes: number[]
}
