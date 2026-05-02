import { useCallback, useEffect, useRef, useState } from 'react'

/** Stale-while-revalidate query for worktree-scoped data. Keeps a
 * module-level cache keyed by (cacheKey, worktreePath) so a tab switch
 * back to a previously-viewed worktree renders instantly from cache
 * while a background refresh runs. The cache entry is dropped when the
 * `worktree:changedFilesInvalidated` watcher signal fires for the
 * current path; until the refetch lands the stale data stays on screen
 * (no flicker). Cache is bounded LRU at 100 entries per cacheKey. */

const CACHE_LIMIT = 100

const caches = new Map<string, Map<string, unknown>>()

function getCache(cacheKey: string): Map<string, unknown> {
  let cache = caches.get(cacheKey)
  if (!cache) {
    cache = new Map()
    caches.set(cacheKey, cache)
  }
  return cache
}

function cacheGet<T>(cacheKey: string, path: string): T | undefined {
  return getCache(cacheKey).get(path) as T | undefined
}

function cacheSet<T>(cacheKey: string, path: string, value: T): void {
  const cache = getCache(cacheKey)
  if (cache.has(path)) cache.delete(path)
  cache.set(path, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function cacheDelete(cacheKey: string, path: string): void {
  getCache(cacheKey).delete(path)
}

export interface UseWatchedQueryOptions<T> {
  worktreePath: string | null
  cacheKey: string
  fetcher: (path: string) => Promise<T>
  fallbackPollMs?: number
}

export interface UseWatchedQueryResult<T> {
  data: T | null
  loading: boolean
  refresh: () => void
}

export function useWatchedQuery<T>(
  opts: UseWatchedQueryOptions<T>
): UseWatchedQueryResult<T> {
  const { worktreePath, cacheKey, fetcher, fallbackPollMs = 60000 } = opts

  const [data, setData] = useState<T | null>(() =>
    worktreePath ? cacheGet<T>(cacheKey, worktreePath) ?? null : null
  )
  const [loading, setLoading] = useState<boolean>(() =>
    worktreePath ? cacheGet<T>(cacheKey, worktreePath) === undefined : false
  )

  const mountedRef = useRef(true)
  const currentPathRef = useRef(worktreePath)
  currentPathRef.current = worktreePath
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    if (!worktreePath) return
    const path = worktreePath
    fetcher(path)
      .then((result) => {
        cacheSet(cacheKey, path, result)
        if (!mountedRef.current) return
        if (currentPathRef.current !== path) return
        setData(result)
        setLoading(false)
      })
      .catch((err) => {
        console.error(`useWatchedQuery(${cacheKey}) fetch failed:`, err)
        if (!mountedRef.current) return
        if (currentPathRef.current !== path) return
        setLoading(false)
      })
  }, [worktreePath, cacheKey, fetcher])

  useEffect(() => {
    if (!worktreePath) {
      setData(null)
      setLoading(false)
      return
    }
    const cached = cacheGet<T>(cacheKey, worktreePath)
    if (cached !== undefined) {
      setData(cached)
      setLoading(false)
    } else {
      setData(null)
      setLoading(true)
    }
    refresh()
  }, [worktreePath, cacheKey, refresh])

  useEffect(() => {
    if (!worktreePath) return
    window.api.watchChangedFiles(worktreePath)
    const offInvalidated = window.api.onChangedFilesInvalidated((path) => {
      if (path !== worktreePath) return
      cacheDelete(cacheKey, worktreePath)
      refresh()
    })
    const interval = setInterval(refresh, fallbackPollMs)
    return () => {
      clearInterval(interval)
      offInvalidated()
      window.api.unwatchChangedFiles(worktreePath)
    }
  }, [worktreePath, cacheKey, refresh, fallbackPollMs])

  return { data, loading, refresh }
}
