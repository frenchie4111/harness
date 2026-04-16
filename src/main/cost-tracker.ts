// CostTracker subscribes to Stop hook events, reads the session jsonl
// pointed at by `transcript_path`, and produces:
//   - per-model usage totals (tokens + $)
//   - a ContentBreakdown attributing the session's $ total across
//     content categories (see src/shared/state/costs.ts).
//
// Strategy: on each Stop, re-parse the whole transcript from scratch
// and dispatch the fresh totals via costs/usageUpdated. Transcripts are
// small (MBs at most) and Stop events are infrequent (once per
// assistant turn), so the simpler full-reparse beats incremental
// tailing + state juggling.
//
// Per-block token counts aren't in the Anthropic usage field, so we
// estimate the $ split by char-length proportion within each turn:
// the turn's known output-rate cost is divided across this message's
// text/thinking/tool_use blocks by their char lengths; the turn's
// input-rate cost is divided across the running context composition
// (accumulated from prior messages' content). A single big tool_result
// naturally gets credited on every subsequent turn's input attribution,
// which captures the "doubly expensive" insight that early large
// outputs keep costing money as long as they sit in the context.

import { readFileSync } from 'fs'
import type { Store } from './store'
import { onStopEvent, type StopEvent } from './hooks'
import {
  emptyTally,
  emptyBreakdown,
  cloneBreakdown,
  type ContentBreakdown,
  type ModelTally,
  type SessionUsage
} from '../shared/state/costs'
import { priceFor, rateFor, type TokenUsage } from '../shared/pricing'
import { log } from './debug'

type Block = Record<string, unknown>

interface CtxChars {
  userPrompt: number
  assistantEcho: number
  toolResults: Record<string, number>
}

interface ParseResult {
  byModel: Record<string, ModelTally>
  breakdown: ContentBreakdown
  currentModel: string | null
}

export class CostTracker {
  private unsubscribe: (() => void) | null = null

  constructor(private store: Store) {}

  start(): void {
    this.unsubscribe = onStopEvent((ev) => this.handleStop(ev))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private handleStop(ev: StopEvent): void {
    try {
      const parsed = parseTranscript(ev.transcriptPath)
      const usage: SessionUsage = {
        sessionId: ev.sessionId,
        transcriptPath: ev.transcriptPath,
        byModel: parsed.byModel,
        breakdown: parsed.breakdown,
        currentModel: parsed.currentModel,
        updatedAt: ev.ts * 1000
      }
      this.store.dispatch({
        type: 'costs/usageUpdated',
        payload: { terminalId: ev.terminalId, usage }
      })
    } catch (err) {
      log(
        'cost-tracker',
        `failed to ingest ${ev.transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }
}

function parseTranscript(path: string): ParseResult {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return { byModel: {}, breakdown: cloneBreakdown(emptyBreakdown), currentModel: null }
  }

  // Detect Codex session format: first non-empty line has type=session_meta
  // or type=event_msg or type=response_item (OpenAI Codex JSONL format).
  const firstLine = text.split('\n').find((l) => l.trim())
  if (firstLine) {
    try {
      const first = JSON.parse(firstLine) as Record<string, unknown>
      if (first.type === 'session_meta' || first.type === 'event_msg' || first.type === 'response_item' || first.type === 'turn_context') {
        return parseCodexTranscript(text)
      }
    } catch { /* fall through to Claude parser */ }
  }

  return parseClaudeTranscript(text)
}

function parseCodexTranscript(text: string): ParseResult {
  const byModel: Record<string, ModelTally> = {}
  const breakdown: ContentBreakdown = cloneBreakdown(emptyBreakdown)
  let currentModel: string | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    // Extract model from turn_context events
    if (obj.type === 'turn_context') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload && typeof payload.model === 'string') {
        currentModel = payload.model
      }
    }

    // Extract token usage from event_msg with type=token_count
    if (obj.type === 'event_msg') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload?.type !== 'token_count') continue
      const info = payload.info as Record<string, unknown> | undefined
      const lastUsage = info?.last_token_usage as Record<string, unknown> | undefined
      if (!lastUsage || !currentModel) continue

      const inputTokens = (lastUsage.input_tokens as number) ?? 0
      const cachedInputTokens = (lastUsage.cached_input_tokens as number) ?? 0
      const outputTokens = (lastUsage.output_tokens as number) ?? 0
      const reasoningTokens = (lastUsage.reasoning_output_tokens as number) ?? 0

      const usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_input_tokens: cachedInputTokens,
        reasoning_output_tokens: reasoningTokens
      }
      const cost = priceFor(currentModel, usage)

      const tally = (byModel[currentModel] ??= { ...emptyTally })
      tally.messages += 1
      tally.input += inputTokens
      tally.output += outputTokens
      tally.cacheRead += cachedInputTokens
      tally.cost += cost

      // Attribute entire cost to text output for simplicity (Codex
      // transcripts don't have per-block character counts like Claude's)
      breakdown.text += cost
    }
  }

  return { byModel, breakdown, currentModel }
}

function parseClaudeTranscript(text: string): ParseResult {
  const byModel: Record<string, ModelTally> = {}
  const breakdown: ContentBreakdown = cloneBreakdown(emptyBreakdown)
  const ctx: CtxChars = { userPrompt: 0, assistantEcho: 0, toolResults: {} }
  const toolNameById: Record<string, string> = {}
  let currentModel: string | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = obj.type
    if (type === 'user') {
      handleUserMessage(obj, ctx, toolNameById)
      continue
    }
    if (type === 'assistant') {
      const model = handleAssistantMessage(obj, ctx, toolNameById, byModel, breakdown)
      if (model) currentModel = model
    }
  }

  return { byModel, breakdown, currentModel }
}

function handleUserMessage(
  obj: Record<string, unknown>,
  ctx: CtxChars,
  toolNameById: Record<string, string>
): void {
  const msg = obj.message as Record<string, unknown> | undefined
  if (!msg) return
  const content = msg.content
  if (typeof content === 'string') {
    ctx.userPrompt += content.length
    return
  }
  if (!Array.isArray(content)) return
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Block
    const btype = block.type
    if (btype === 'text') {
      const t = block.text
      if (typeof t === 'string') ctx.userPrompt += t.length
    } else if (btype === 'tool_result') {
      const id = block.tool_use_id as string | undefined
      const name = (id && toolNameById[id]) || 'unknown'
      const chars = charLenOfToolResultContent(block.content)
      ctx.toolResults[name] = (ctx.toolResults[name] ?? 0) + chars
    }
  }
}

function handleAssistantMessage(
  obj: Record<string, unknown>,
  ctx: CtxChars,
  toolNameById: Record<string, string>,
  byModel: Record<string, ModelTally>,
  breakdown: ContentBreakdown
): string | null {
  const msg = obj.message as Record<string, unknown> | undefined
  if (!msg) return null
  const model = typeof msg.model === 'string' ? msg.model : null
  const usage = (msg.usage ?? null) as TokenUsage | null
  if (!model || !usage) return null

  // Walk this turn's output content and collect char counts by block type.
  const content = Array.isArray(msg.content) ? (msg.content as Block[]) : []
  let textChars = 0
  let thinkingChars = 0
  let toolUseChars = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const btype = block.type
    if (btype === 'text') {
      const t = block.text
      if (typeof t === 'string') textChars += t.length
    } else if (btype === 'thinking') {
      const t = block.thinking
      if (typeof t === 'string') thinkingChars += t.length
    } else if (btype === 'tool_use') {
      const id = block.id as string | undefined
      const name = block.name as string | undefined
      if (id && name) toolNameById[id] = name
      toolUseChars += JSON.stringify(block.input ?? null).length
    }
  }

  const turnCost = priceFor(model, usage)
  const rate = rateFor(model)
  const outputCost = rate ? ((usage.output_tokens ?? 0) * rate.out) / 1_000_000 : 0
  const inputCost = Math.max(0, turnCost - outputCost)

  // Output-side attribution: split outputCost across this turn's blocks.
  const outTotal = textChars + thinkingChars + toolUseChars
  if (outTotal > 0 && outputCost > 0) {
    breakdown.text += (outputCost * textChars) / outTotal
    breakdown.thinking += (outputCost * thinkingChars) / outTotal
    breakdown.toolUse += (outputCost * toolUseChars) / outTotal
  } else {
    // Degenerate turn with cost but no parseable blocks — lump into text.
    breakdown.text += outputCost
  }

  // Input-side attribution: split inputCost across the running context
  // composition as it stood BEFORE this turn's assistant output was added.
  const ctxToolTotal = Object.values(ctx.toolResults).reduce((a, b) => a + b, 0)
  const ctxTotal = ctx.userPrompt + ctx.assistantEcho + ctxToolTotal
  if (ctxTotal > 0 && inputCost > 0) {
    breakdown.userPrompt += (inputCost * ctx.userPrompt) / ctxTotal
    breakdown.assistantEcho += (inputCost * ctx.assistantEcho) / ctxTotal
    for (const [name, chars] of Object.entries(ctx.toolResults)) {
      breakdown.toolResults[name] =
        (breakdown.toolResults[name] ?? 0) + (inputCost * chars) / ctxTotal
    }
  } else if (inputCost > 0) {
    // First turn — no prior context, but we still paid an input-rate bill
    // (system prompt, etc.). Park it under assistantEcho as the closest
    // "not user, not tool output" bucket. Rare and small.
    breakdown.assistantEcho += inputCost
  }

  // This assistant message now joins the running context for future turns.
  ctx.assistantEcho += textChars + thinkingChars + toolUseChars

  // Update per-model tally.
  const tally = (byModel[model] ??= { ...emptyTally })
  tally.messages += 1
  tally.input += usage.input_tokens ?? 0
  tally.output += usage.output_tokens ?? 0
  tally.cacheRead += usage.cache_read_input_tokens ?? 0
  tally.cacheWrite += usage.cache_creation_input_tokens ?? 0
  tally.cost += turnCost

  return model
}

function charLenOfToolResultContent(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Block
      if (p.type === 'text' && typeof p.text === 'string') total += p.text.length
      // image blocks contribute nontrivially but we can't char-count them;
      // ignore for now — they're rare in tool_results.
    }
    return total
  }
  return 0
}
