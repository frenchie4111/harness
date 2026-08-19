import { describe, it, expect } from 'vitest'
import { analyzeContext } from './context-window'
import { totalCategories } from '../shared/state/context-window'

const MODEL = 'claude-opus-5'

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function userText(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'user', message: { role: 'user', content: text }, ...extra }
}

function toolResult(toolUseId: string, text: string): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]
    }
  }
}

/** One `assistant` record. Pass the same requestId across several to
 *  reproduce how Claude Code splits a single API message per block. */
function assistant(
  requestId: string,
  blocks: unknown[],
  usage: { prompt: number; output: number } | null
): unknown {
  return {
    type: 'assistant',
    requestId,
    message: {
      id: `msg-${requestId}`,
      role: 'assistant',
      model: MODEL,
      content: blocks,
      ...(usage
        ? {
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: usage.prompt,
              cache_creation_input_tokens: 0,
              output_tokens: usage.output
            }
          }
        : {})
    }
  }
}

describe('analyzeContext', () => {
  it('reports nothing measured for an empty transcript', () => {
    const a = analyzeContext('')
    expect(a.measured).toBe(false)
    expect(a.usedTokens).toBe(0)
    expect(a.model).toBeNull()
  })

  it('estimates from chars when no assistant turn has landed yet', () => {
    const a = analyzeContext(jsonl(userText('x'.repeat(400))))
    expect(a.measured).toBe(false)
    expect(a.categories.userPrompts).toBe(100)
    expect(a.categories.systemAndTools).toBe(0)
  })

  it('anchors usedTokens to the last turn prompt + output', () => {
    const a = analyzeContext(
      jsonl(
        userText('hello'),
        assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 1000, output: 50 })
      )
    )
    expect(a.measured).toBe(true)
    expect(a.usedTokens).toBe(1050)
    expect(a.categories.assistantText).toBe(50)
    expect(a.model).toBe(MODEL)
  })

  it('derives systemAndTools as the unattributed residual', () => {
    const a = analyzeContext(
      jsonl(
        userText('hello'),
        assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 1000, output: 50 })
      )
    )
    // 1000 prompt, of which ~1 token is the user message; the rest is
    // system prompt + tool schemas.
    expect(a.categories.systemAndTools).toBe(999)
    expect(totalCategories(a.categories)).toBe(a.usedTokens)
  })

  it('attributes the measured inter-turn delta to the tool result', () => {
    const a = analyzeContext(
      jsonl(
        userText('go'),
        assistant('r1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }], {
          prompt: 1000,
          output: 50
        }),
        toolResult('t1', 'x'.repeat(4000)),
        assistant('r2', [{ type: 'text', text: 'done' }], { prompt: 2100, output: 20 })
      )
    )
    // delta 1100, of which 50 was r1's own output; the remaining 1050
    // is the Read result. Not the 1000 a chars/4 estimate would give.
    expect(a.categories.toolResults.Read).toBe(1050)
    expect(a.categories.toolCalls).toBe(50)
    expect(a.usedTokens).toBe(2120)
    expect(totalCategories(a.categories)).toBe(a.usedTokens)
  })

  it('treats records sharing a requestId as one turn', () => {
    const split = analyzeContext(
      jsonl(
        userText('go'),
        assistant('r1', [{ type: 'thinking', thinking: 'hmm' }], { prompt: 1000, output: 60 }),
        assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 1000, output: 60 }),
        assistant('r1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], {
          prompt: 1000,
          output: 60
        })
      )
    )
    // One turn, so usedTokens is 1000 + 60 — not 3 turns' worth.
    expect(split.usedTokens).toBe(1060)
    // r1's 60 output tokens are split across its three blocks.
    const produced =
      split.categories.thinking + split.categories.assistantText + split.categories.toolCalls
    expect(produced).toBe(60)
  })

  it('excludes subagent sidechains from the parent window', () => {
    const withSidechain = analyzeContext(
      jsonl(
        userText('go'),
        { ...(userText('x'.repeat(8000)) as object), isSidechain: true },
        assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 1000, output: 50 })
      )
    )
    expect(withSidechain.categories.userPrompts).toBe(1)
    expect(withSidechain.usedTokens).toBe(1050)
  })

  it('starts the live era after the last compaction', () => {
    const a = analyzeContext(
      jsonl(
        userText('ancient history'),
        assistant('r0', [{ type: 'text', text: 'x'.repeat(4000) }], {
          prompt: 160000,
          output: 900
        }),
        {
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: { trigger: 'auto', preTokens: 167836, postTokens: 10909 }
        },
        userText('summary of what came before', { isCompactSummary: true }),
        assistant('r1', [{ type: 'text', text: 'ok' }], { prompt: 41780, output: 88 })
      )
    )
    expect(a.compactions).toBe(1)
    // The pre-compaction 160k turn is gone from the window.
    expect(a.usedTokens).toBe(41868)
    // postTokens is authoritative for the carried summary.
    expect(a.categories.carriedSummary).toBe(10909)
    // Leaving a system+tools baseline consistent with a fresh session.
    expect(a.categories.systemAndTools).toBe(41780 - 10909)
    expect(totalCategories(a.categories)).toBe(a.usedTokens)
  })

  it('prefers the session own observed compaction trigger point', () => {
    const a = analyzeContext(
      jsonl(
        {
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: { trigger: 'auto', preTokens: 167836, postTokens: 10909 }
        },
        userText('summary', { isCompactSummary: true }),
        assistant('r1', [{ type: 'text', text: 'ok' }], { prompt: 41780, output: 88 })
      )
    )
    expect(a.autocompactAt).toBe(167836)
  })

  it('falls back to a fraction of the limit when never compacted', () => {
    const a = analyzeContext(
      jsonl(userText('hi'), assistant('r1', [{ type: 'text', text: 'yo' }], { prompt: 100, output: 5 }))
    )
    expect(a.compactions).toBe(0)
    expect(a.autocompactAt).toBe(168000)
    expect(a.limit).toBe(200000)
  })

  it('promotes the window when the session outgrew the table limit', () => {
    // The 1M beta is enabled per session and the model id does not carry
    // a [1m] marker, so a 596k prompt is the only evidence there is.
    const a = analyzeContext(
      jsonl(
        userText('go'),
        assistant('r1', [{ type: 'text', text: 'ok' }], { prompt: 596531, output: 802 })
      )
    )
    expect(a.limit).toBe(1_000_000)
    expect(a.usedTokens).toBeLessThan(a.limit)
  })

  it('leaves the table limit alone for a session that fits', () => {
    const a = analyzeContext(
      jsonl(
        userText('go'),
        assistant('r1', [{ type: 'text', text: 'ok' }], { prompt: 150_000, output: 100 })
      )
    )
    expect(a.limit).toBe(200_000)
  })

  it('tracks which tools are still discoverable', () => {
    const a = analyzeContext(
      jsonl(
        userText('go'),
        {
          type: 'attachment',
          attachment: {
            type: 'deferred_tools_delta',
            addedNames: ['WebFetch', 'WebSearch', 'Monitor'],
            removedNames: []
          }
        },
        {
          type: 'attachment',
          attachment: {
            type: 'deferred_tools_delta',
            addedNames: [],
            removedNames: ['Monitor']
          }
        },
        assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 1000, output: 50 })
      )
    )
    // Monitor got loaded, so it is in the window rather than discoverable.
    expect(a.discoverableTools).toEqual(['WebFetch', 'WebSearch'])
  })

  it('carves a memory-file estimate out of the system residual', () => {
    const transcript = jsonl(
      userText('hello'),
      assistant('r1', [{ type: 'text', text: 'hi' }], { prompt: 10000, output: 50 })
    )
    const without = analyzeContext(transcript)
    const withMemory = analyzeContext(transcript, 8000)
    expect(withMemory.categories.memoryFiles).toBe(2000)
    expect(withMemory.categories.systemAndTools).toBe(without.categories.systemAndTools - 2000)
    expect(totalCategories(withMemory.categories)).toBe(withMemory.usedTokens)
  })

  it('never lets a memory estimate exceed the residual', () => {
    const a = analyzeContext(
      jsonl(userText('hi'), assistant('r1', [{ type: 'text', text: 'yo' }], { prompt: 100, output: 5 })),
      10_000_000
    )
    expect(a.categories.systemAndTools).toBe(0)
    expect(a.categories.memoryFiles).toBeLessThanOrEqual(a.usedTokens)
    expect(totalCategories(a.categories)).toBe(a.usedTokens)
  })

  it('skips malformed lines rather than throwing', () => {
    const a = analyzeContext(
      'not json\n' +
        jsonl(userText('hi'), assistant('r1', [{ type: 'text', text: 'yo' }], { prompt: 100, output: 5 })) +
        '{"truncated":\n'
    )
    expect(a.measured).toBe(true)
    expect(a.usedTokens).toBe(105)
  })

  it('keeps category bars summing to the headline number', () => {
    const a = analyzeContext(
      jsonl(
        userText('start'),
        { type: 'attachment', attachment: { type: 'skill_listing', content: 'x'.repeat(2000) } },
        assistant('r1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }], {
          prompt: 5000,
          output: 40
        }),
        toolResult('t1', 'y'.repeat(1200)),
        assistant('r2', [{ type: 'thinking', thinking: 'think' }], { prompt: 5600, output: 30 }),
        assistant('r2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { p: 'f' } }], {
          prompt: 5600,
          output: 30
        }),
        toolResult('t2', 'z'.repeat(900))
      )
    )
    expect(totalCategories(a.categories)).toBe(a.usedTokens)
    expect(Object.keys(a.categories.toolResults).sort()).toEqual(['Bash', 'Read'])
  })
})
