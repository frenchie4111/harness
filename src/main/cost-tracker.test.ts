import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Controlled fs mock: readFileSync returns a JSONL transcript fixture
// which we override per-test. existsSync is unused by parseTranscript
// (it just lets readFileSync throw), so leaving the real one in place
// is fine.
const readFileSyncMock = vi.fn((..._args: unknown[]) => '')

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args)
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setPath: () => {}, isPackaged: false }
}))

import { Store } from './store'
import { CostTracker } from './cost-tracker'

describe('CostTracker — JSON-mode wiring', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset()
    readFileSyncMock.mockReturnValue('')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reparses + dispatches costs/usageUpdated when a json-claude turn completes', () => {
    const store = new Store()
    const tracker = new CostTracker(store)
    tracker.start()
    tracker.setClientInterested('client-A', true)

    const sessionId = 'sess-cost-1'

    // Start with an empty transcript so the sessionStarted reparse is
    // a no-op (gated by the empty-byModel check). This isolates the
    // assertion to the busyChanged path.
    readFileSyncMock.mockReturnValue('')
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/wt' }
    })
    expect(store.getSnapshot().state.costs.byTerminal[sessionId]).toBeUndefined()

    // claude has now finished a turn and flushed its session jsonl.
    // The parser only needs type=assistant, message.model,
    // message.usage, message.content.
    const transcript =
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: 'hi there' }]
        }
      }) + '\n'
    readFileSyncMock.mockReturnValue(transcript)

    // The result-event boundary in JsonClaudeManager dispatches
    // busyChanged false. CostTracker subscribes to that.
    store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })

    tracker.stop()

    const usage = store.getSnapshot().state.costs.byTerminal[sessionId]
    expect(usage).toBeDefined()
    expect(usage.byModel['claude-sonnet-4-5']?.input).toBe(100)
    expect(usage.byModel['claude-sonnet-4-5']?.output).toBe(50)
    expect(usage.sessionId).toBe(sessionId)
  })

  it('incremental parse across two turns matches a single-shot reparse of the final file', () => {
    const sessionId = 'sess-cost-incr'
    const turn1 =
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: 'first turn output' }]
        }
      }) + '\n'
    const turn2 =
      JSON.stringify({
        type: 'user',
        message: { content: 'follow up' }
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 200, output_tokens: 80 },
          content: [{ type: 'text', text: 'second turn output is longer' }]
        }
      }) +
      '\n'
    const fullTranscript = turn1 + turn2

    // Path A: incremental — first parse sees turn1, second parse sees the full file.
    const storeA = new Store()
    const trackerA = new CostTracker(storeA)
    trackerA.start()
    trackerA.setClientInterested('client-A', true)
    storeA.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/wt' }
    })
    readFileSyncMock.mockReturnValue(turn1)
    storeA.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    readFileSyncMock.mockReturnValue(fullTranscript)
    storeA.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })
    trackerA.stop()
    const incremental = storeA.getSnapshot().state.costs.byTerminal[sessionId]

    // Path B: single-shot reparse of the final file via a fresh tracker.
    const storeB = new Store()
    const trackerB = new CostTracker(storeB)
    trackerB.start()
    trackerB.setClientInterested('client-B', true)
    readFileSyncMock.mockReturnValue(fullTranscript)
    storeB.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/wt' }
    })
    trackerB.stop()
    const singleShot = storeB.getSnapshot().state.costs.byTerminal[sessionId]

    expect(incremental.byModel).toEqual(singleShot.byModel)
    expect(incremental.breakdown).toEqual(singleShot.breakdown)
    expect(incremental.currentModel).toBe(singleShot.currentModel)
  })

  it('skips the dispatch when the transcript has no parseable assistant turn', () => {
    // Resume-from-disk before claude has flushed: parseTranscript
    // returns empty data. Dispatching it would wipe whatever the slice
    // already had hydrated, so we gate on byModel having entries.
    readFileSyncMock.mockReturnValue('')

    const store = new Store()
    const tracker = new CostTracker(store)
    tracker.start()
    tracker.setClientInterested('client-A', true)

    const sessionId = 'sess-cost-2'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/wt' }
    })
    // sessionStarted itself triggers a reparse on resume; that
    // empty-transcript run must not have dispatched usageUpdated.

    tracker.stop()

    expect(store.getSnapshot().state.costs.byTerminal[sessionId]).toBeUndefined()
  })

  it('skips parsing while no client is interested, then backfills on first interest', () => {
    const store = new Store()
    const tracker = new CostTracker(store)
    tracker.start()
    // No client interest yet — this matches the default state when
    // every renderer has the (default-collapsed) CostPanel collapsed.

    const sessionId = 'sess-cost-gated'
    const transcript =
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: 'hi' }]
        }
      }) + '\n'
    readFileSyncMock.mockReturnValue(transcript)

    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: '/tmp/wt' }
    })
    store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy: false }
    })

    // Nothing dispatched while no client cared.
    expect(store.getSnapshot().state.costs.byTerminal[sessionId]).toBeUndefined()
    expect(readFileSyncMock).not.toHaveBeenCalled()

    // First client expands the panel — backfill kicks in for known
    // json-mode sessions and produces the totals.
    tracker.setClientInterested('client-A', true)
    const usage = store.getSnapshot().state.costs.byTerminal[sessionId]
    expect(usage).toBeDefined()
    expect(usage.byModel['claude-sonnet-4-5']?.input).toBe(100)

    tracker.stop()
  })
})
