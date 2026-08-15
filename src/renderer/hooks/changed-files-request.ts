import type { ChangedFile } from '../types'
import type { ElectronAPI } from '../types'

// In-flight dedup for `getChangedFiles`.
//
// The panels that show changed files don't share a cache entry: ChangedFilesPanel
// keys on 'changedFiles' (and fetches working+branch together) while
// useChangedFilesSet keys on 'branchChangedFiles'. When both are mounted they
// ask the main process the same `mode: 'branch'` question at the same instant,
// and each answer costs three git subprocesses. Production perf traces showed a
// steady 2:1 branch:working ratio — i.e. one of every two branch diffs was
// redundant.
//
// Dedup is deliberately in-flight only; nothing is cached past settlement, so a
// join can only ever merge calls that already overlap in time. `force` skips the
// join for invalidation-driven refreshes, which must not be served by a request
// that started before the change they're reacting to.

type Mode = 'working' | 'branch'

const inFlight = new Map<string, Promise<ChangedFile[]>>()

export function requestChangedFiles(
  backend: ElectronAPI,
  path: string,
  mode: Mode,
  opts: { force?: boolean } = {}
): Promise<ChangedFile[]> {
  const key = `${mode}::${path}`
  if (!opts.force) {
    const existing = inFlight.get(key)
    if (existing) return existing
  }
  const promise = backend.getChangedFiles(path, mode).finally(() => {
    // Only clear if we're still the current entry — a forced refresh may have
    // replaced us while this request was in flight.
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}
