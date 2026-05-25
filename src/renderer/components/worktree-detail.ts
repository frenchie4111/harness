/** Compact age label for the sidebar. Years switch in at >=365 days so a
 *  long-lived worktree doesn't read as a giant day count. `now` is a
 *  parameter so tests don't have to mock Date. */
export function formatWorktreeAge(createdAt: number, now: number = Date.now()): string {
  if (!createdAt) return '—'
  const ms = now - createdAt
  if (ms < 0) return '—'
  const hours = ms / (1000 * 60 * 60)
  if (hours < 1) return '<1h'
  const days = hours / 24
  if (days < 1) return `${Math.floor(hours)}h`
  if (days < 365) return `${Math.floor(days)}d`
  return `${(days / 365).toFixed(1)}y`
}
