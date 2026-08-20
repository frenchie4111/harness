import { describe, expect, it } from 'vitest'
import {
  initialSessionImport,
  sessionImportReducer,
  type SessionImportState
} from './session-import'

describe('sessionImportReducer', () => {
  it('scanStarted moves to scanning and clears prior progress and error', () => {
    const state: SessionImportState = {
      ...initialSessionImport,
      status: 'error',
      scanned: 40,
      total: 80,
      error: 'boom'
    }
    const next = sessionImportReducer(state, { type: 'sessionImport/scanStarted' })
    expect(next.status).toBe('scanning')
    expect(next.scanned).toBe(0)
    expect(next.total).toBe(0)
    expect(next.error).toBeNull()
  })

  it('scanStarted keeps the previous results visible while rescanning', () => {
    const state: SessionImportState = {
      ...initialSessionImport,
      status: 'ready',
      sessionCount: 10,
      groupCount: 2,
      lastScanAt: 500
    }
    const next = sessionImportReducer(state, { type: 'sessionImport/scanStarted' })
    expect(next.sessionCount).toBe(10)
    expect(next.groupCount).toBe(2)
    expect(next.lastScanAt).toBe(500)
  })

  it('scanProgress records counts', () => {
    const next = sessionImportReducer(initialSessionImport, {
      type: 'sessionImport/scanProgress',
      payload: { scanned: 5, total: 100 }
    })
    expect(next.scanned).toBe(5)
    expect(next.total).toBe(100)
  })

  it('scanProgress returns the same reference when nothing changed', () => {
    const state: SessionImportState = { ...initialSessionImport, scanned: 5, total: 100 }
    const next = sessionImportReducer(state, {
      type: 'sessionImport/scanProgress',
      payload: { scanned: 5, total: 100 }
    })
    expect(next).toBe(state)
  })

  it('scanCompleted records results and clears the error', () => {
    const state: SessionImportState = {
      ...initialSessionImport,
      status: 'scanning',
      error: 'stale'
    }
    const next = sessionImportReducer(state, {
      type: 'sessionImport/scanCompleted',
      payload: { sessionCount: 8325, groupCount: 16, at: 1234 }
    })
    expect(next.status).toBe('ready')
    expect(next.sessionCount).toBe(8325)
    expect(next.groupCount).toBe(16)
    expect(next.lastScanAt).toBe(1234)
    expect(next.error).toBeNull()
  })

  it('scanFailed records the reason', () => {
    const next = sessionImportReducer(initialSessionImport, {
      type: 'sessionImport/scanFailed',
      payload: 'permission denied'
    })
    expect(next.status).toBe('error')
    expect(next.error).toBe('permission denied')
  })

  it('ignores unrelated events', () => {
    const next = sessionImportReducer(initialSessionImport, {
      type: 'other/thing'
    } as never)
    expect(next).toBe(initialSessionImport)
  })
})
