/** Status of the background scan that discovers Claude Code sessions on disk
 *  for the import browser.
 *
 *  Only the STATUS lives here, not the scan results. The results are a
 *  multi-megabyte list — 8325 sessions on the corpus this was built against
 *  — and they are re-derivable from disk at any time. Mirroring them through
 *  the reducer would copy megabytes into every connected client on a value
 *  that only one modal reads, so the tree is fetched on demand over a
 *  request IPC and held in component state instead. The progress and
 *  freshness counters below are what a second client would genuinely want to
 *  see, and they are small. */

export interface SessionImportState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  /** Files processed so far in the in-flight scan. */
  scanned: number
  /** Total files the in-flight scan expects to process. */
  total: number
  /** Sessions discovered by the most recent successful scan. */
  sessionCount: number
  /** Top-level groups produced by the most recent successful scan. */
  groupCount: number
  /** Epoch ms of the most recent successful scan, or null if never run. */
  lastScanAt: number | null
  error: string | null
}

export type SessionImportEvent =
  | { type: 'sessionImport/scanStarted' }
  | { type: 'sessionImport/scanProgress'; payload: { scanned: number; total: number } }
  | {
      type: 'sessionImport/scanCompleted'
      payload: { sessionCount: number; groupCount: number; at: number }
    }
  | { type: 'sessionImport/scanFailed'; payload: string }

export const initialSessionImport: SessionImportState = {
  status: 'idle',
  scanned: 0,
  total: 0,
  sessionCount: 0,
  groupCount: 0,
  lastScanAt: null,
  error: null
}

export function sessionImportReducer(
  state: SessionImportState,
  event: SessionImportEvent
): SessionImportState {
  switch (event.type) {
    case 'sessionImport/scanStarted':
      return { ...state, status: 'scanning', scanned: 0, total: 0, error: null }
    case 'sessionImport/scanProgress': {
      const { scanned, total } = event.payload
      // Progress fires once per file. Identity-check so a repeated value
      // can't wake every subscriber mid-scan.
      if (state.scanned === scanned && state.total === total) return state
      return { ...state, scanned, total }
    }
    case 'sessionImport/scanCompleted': {
      const { sessionCount, groupCount, at } = event.payload
      return {
        ...state,
        status: 'ready',
        sessionCount,
        groupCount,
        lastScanAt: at,
        error: null
      }
    }
    case 'sessionImport/scanFailed':
      return { ...state, status: 'error', error: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
