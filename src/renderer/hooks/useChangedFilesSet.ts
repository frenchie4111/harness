import { useCallback, useMemo } from 'react'
import type { ChangedFile } from '../types'
import { useBackend } from '../backend'
import { useWatchedQuery } from './useWatchedQuery'

/** Single-letter glyphs that mirror the labels used in the
 *  ChangedFilesPanel "Committed" section. Surfaces that want to
 *  reuse the same visual language (e.g. AllFilesPanel, CommandPalette)
 *  import these instead of re-defining them. */
export const CHANGED_STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

export const CHANGED_STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim',
}

export interface ChangedFilesSetResult {
  /** Per-path lookup. Use `.has(p)` for inclusion checks, `.get(p)` for
   *  the full entry (status, additions, deletions). */
  byPath: Map<string, ChangedFile>
  /** Folders (no trailing slash) that contain at least one changed
   *  descendant. Useful for tree rollup indicators. */
  folders: Set<string>
  /** Original ordering as returned by git (newest-touched first when
   *  available). Used by the Command Palette to pick the top N for the
   *  "Changed in this PR" section. */
  list: ChangedFile[]
}

const EMPTY: ChangedFilesSetResult = {
  byPath: new Map(),
  folders: new Set(),
  list: [],
}

export function useChangedFilesSet(worktreePath: string | null): ChangedFilesSetResult {
  const backend = useBackend()
  const fetcher = useCallback(
    (path: string) => backend.getChangedFiles(path, 'branch'),
    [backend]
  )

  const { data } = useWatchedQuery<ChangedFile[]>({
    worktreePath,
    cacheKey: 'branchChangedFiles',
    fetcher,
  })

  return useMemo(() => {
    if (!data || data.length === 0) return EMPTY
    const byPath = new Map<string, ChangedFile>()
    const folders = new Set<string>()
    for (const f of data) {
      byPath.set(f.path, f)
      let idx = f.path.indexOf('/')
      while (idx >= 0) {
        folders.add(f.path.slice(0, idx))
        idx = f.path.indexOf('/', idx + 1)
      }
    }
    return { byPath, folders, list: data }
  }, [data])
}
