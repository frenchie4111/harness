import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { GroupKey } from '../worktree-sort'

/** Per-client collapse / layout preferences for the worktree list. Renderer
 *  state by design (CLAUDE.md: per-viewer UI layout isn't slice state), but
 *  shared between the desktop sidebar and the touch picker so both surfaces
 *  honour the same expansion and the same unified-vs-split repo mode. */
export interface WorktreeCollapseState {
  collapsedGroups: Record<string, boolean>
  setCollapsedGroups: Dispatch<SetStateAction<Record<string, boolean>>>
  collapsedRepos: Record<string, boolean>
  setCollapsedRepos: Dispatch<SetStateAction<Record<string, boolean>>>
  unifiedRepos: boolean
  setUnifiedRepos: Dispatch<SetStateAction<boolean>>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  toggleGroup: (scope: string, key: GroupKey) => void
  toggleRepo: (repoRoot: string) => void
}

/** Merged and snoozed start collapsed — they're archives, not workspaces. */
function defaultCollapsed(key: GroupKey): boolean {
  return key === 'merged' || key === 'snoozed'
}

export function useWorktreeCollapse(): WorktreeCollapseState {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('harness:collapsedGroups')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    localStorage.setItem('harness:collapsedGroups', JSON.stringify(collapsedGroups))
  }, [collapsedGroups])

  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({})

  const [unifiedRepos, setUnifiedRepos] = useState<boolean>(() => {
    const saved = localStorage.getItem('harness:unifiedRepos')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:unifiedRepos', unifiedRepos ? '1' : '0')
  }, [unifiedRepos])

  const isGroupCollapsed = useCallback(
    (scope: string, key: GroupKey): boolean => {
      const composite = `${scope}:${key}`
      if (composite in collapsedGroups) return collapsedGroups[composite]
      return defaultCollapsed(key)
    },
    [collapsedGroups]
  )

  const toggleGroup = useCallback((scope: string, key: GroupKey) => {
    const composite = `${scope}:${key}`
    setCollapsedGroups((prev) => {
      const current = composite in prev ? prev[composite] : defaultCollapsed(key)
      return { ...prev, [composite]: !current }
    })
  }, [])

  const toggleRepo = useCallback((repoRoot: string) => {
    setCollapsedRepos((prev) => ({ ...prev, [repoRoot]: !prev[repoRoot] }))
  }, [])

  return {
    collapsedGroups,
    setCollapsedGroups,
    collapsedRepos,
    setCollapsedRepos,
    unifiedRepos,
    setUnifiedRepos,
    isGroupCollapsed,
    toggleGroup,
    toggleRepo
  }
}
