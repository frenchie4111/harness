import { useCallback, useMemo } from 'react'
import type { ChangedFile } from '../types'
import { useBackend } from '../backend'
import { useWatchedQuery } from './useWatchedQuery'

export interface ChangedFilesSetResult {
  /** Relative paths in the branch diff vs base — what a PR would contain. */
  paths: Set<string>
  /** Folders (with trailing slash trimmed) that contain at least one
   *  changed descendant. Useful for tree rollup indicators. */
  folders: Set<string>
  /** Original ordering as returned by git (newest-touched first when
   *  available). Used by the Command Palette to pick the top N for the
   *  "Changed in this PR" section. */
  list: ChangedFile[]
}

const EMPTY: ChangedFilesSetResult = {
  paths: new Set(),
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
    const paths = new Set<string>()
    const folders = new Set<string>()
    for (const f of data) {
      paths.add(f.path)
      let idx = f.path.indexOf('/')
      while (idx >= 0) {
        folders.add(f.path.slice(0, idx))
        idx = f.path.indexOf('/', idx + 1)
      }
    }
    return { paths, folders, list: data }
  }, [data])
}
