import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { Store } from './store'
import { tailLog, cleanupTerminalLog } from './hooks'
import type { StateEvent } from '../shared/state'

// tailLog reads from the real status dir (/tmp/harness-status). We use a
// unique terminal id per test so the module-level offset/residual maps and
// the on-disk .ndjson file never collide with other tests, and clean both
// up afterward via cleanupTerminalLog.
const STATUS_DIR = '/tmp/harness-status'

// Build one NDJSON hook record line as the bash hook command would emit it.
function record(event: string, payload: Record<string, unknown> | null, ts = 1): string {
  return JSON.stringify({ event, ts, payload }) + '\n'
}

function statusEvents(store: Store): StateEvent[] {
  const events: StateEvent[] = []
  store.subscribe((ev) => {
    if (ev.type === 'terminals/statusChanged') events.push(ev)
  })
  return events
}

describe('tailLog — boot-replay guard', () => {
  let terminalId: string
  let logPath: string
  let counter = 0

  beforeEach(() => {
    mkdirSync(STATUS_DIR, { recursive: true })
    counter += 1
    terminalId = `test-hooks-${counter}-${process.pid}`
    logPath = join(STATUS_DIR, `${terminalId}.ndjson`)
  })

  afterEach(() => {
    cleanupTerminalLog(terminalId)
  })

  it('dispatches only one statusChanged on first touch of a long history', () => {
    // A terminal whose .ndjson survived a restart: many historical records
    // ending in a Stop (current status = waiting).
    const history =
      record('UserPromptSubmit', { session_id: 's' }) +
      record('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }) +
      record('PostToolUse', { tool_name: 'Bash' }) +
      record('PreToolUse', { tool_name: 'Edit', tool_input: {} }) +
      record('PostToolUse', { tool_name: 'Edit' }) +
      record('Stop', { session_id: 's', transcript_path: '/tmp/t.jsonl' })
    writeFileSync(logPath, history)

    const store = new Store()
    const events = statusEvents(store)

    tailLog(terminalId, store)

    // Naive read-from-0 would dispatch 6 status changes; the guard collapses
    // to just the final record's status.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'terminals/statusChanged',
      payload: { id: terminalId, status: 'waiting' }
    })
  })

  it('processes every newly-appended line on subsequent tails', () => {
    writeFileSync(logPath, record('Stop', { session_id: 's' }))

    const store = new Store()
    const events = statusEvents(store)

    // First touch: seed offset to EOF, one dispatch for the last record.
    tailLog(terminalId, store)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ payload: { status: 'waiting' } })

    // Two live events arrive after boot. Both must be processed now that the
    // offset is seeded — no first-touch collapse on subsequent tails.
    appendFileSync(
      logPath,
      record('PreToolUse', { tool_name: 'Bash', tool_input: {} }) +
        record('Stop', { session_id: 's' })
    )
    tailLog(terminalId, store)

    expect(events).toHaveLength(3)
    expect(events[1]).toMatchObject({ payload: { status: 'processing' } })
    expect(events[2]).toMatchObject({ payload: { status: 'waiting' } })
  })
})
