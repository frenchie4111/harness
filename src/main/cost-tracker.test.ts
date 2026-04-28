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

  it('skips the dispatch when the transcript has no parseable assistant turn', () => {
    // Resume-from-disk before claude has flushed: parseTranscript
    // returns empty data. Dispatching it would wipe whatever the slice
    // already had hydrated, so we gate on byModel having entries.
    readFileSyncMock.mockReturnValue('')

    const store = new Store()
    const tracker = new CostTracker(store)
    tracker.start()

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
})
