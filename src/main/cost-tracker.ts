// CostTracker subscribes to Stop hook events, reads the session jsonl
// pointed at by `transcript_path`, and produces:
//   - per-model usage totals (tokens + $)
//   - a ContentBreakdown attributing the session's $ total across
//     content categories (see src/shared/state/costs.ts).
//
// Strategy: maintain a per-session cache of partially-parsed state and
// fold only the bytes appended since last parse into it. Transcripts grow
// without bound across a session, so the original full-reparse approach
// scaled with transcript size and showed up as the worst [store-slow]
// listener in perf.log. The accumulators fold linearly from beginning to
// end, so incremental parsing produces totals identical to a single-shot
// reparse — that's the property the regression test pins down.
//
// JSON-mode tabs don't fire Claude's Stop hook (we scrub the
// HARNESS_TERMINAL_ID env var so user-scope hooks stay inert under
// `claude -p`). Instead, we subscribe to the store and trigger the same
// reparse on `jsonClaude/busyChanged` transitions to false (the boundary
// JsonClaudeManager dispatches when claude emits a `result` event), and
// on `jsonClaude/sessionStarted` so reopened tabs rehydrate from the
// on-disk JSONL even if the costs slice doesn't persist their entry.
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
import { homedir } from 'os'
import { join } from 'path'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
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

interface CacheEntry {
  charOffset: number
  format: 'claude' | 'codex' | null
  byModel: Record<string, ModelTally>
  breakdown: ContentBreakdown
  ctx: CtxChars
  toolNameById: Record<string, string>
  currentModel: string | null
}

function newCacheEntry(): CacheEntry {
  return {
    charOffset: 0,
    format: null,
    byModel: {},
    breakdown: cloneBreakdown(emptyBreakdown),
    ctx: { userPrompt: 0, assistantEcho: 0, toolResults: {} },
    toolNameById: {},
    currentModel: null
  }
}

function resetCacheEntry(entry: CacheEntry): void {
  entry.charOffset = 0
  entry.format = null
  entry.byModel = {}
  entry.breakdown = cloneBreakdown(emptyBreakdown)
  entry.ctx = { userPrompt: 0, assistantEcho: 0, toolResults: {} }
  entry.toolNameById = {}
  entry.currentModel = null
}

export class CostTracker {
  private unsubscribeHook: (() => void) | null = null
  private unsubscribeStore: (() => void) | null = null
  private cache = new Map<string, CacheEntry>()
  // The CostPanel is collapsed by default and most users never open it.
  // Parsing + dispatching on every turn boundary for a panel nobody is
  // looking at burns CPU and inflates the costs slice. Clients (one per
  // BrowserWindow / WS peer) signal interest via costs:setInterest; while
  // the set is empty, handleStop / recordJsonModeTurnComplete short-circuit.
  // The last StopEvent per terminal is retained so we can backfill on the
  // next 0→positive transition without waiting for another turn.
  private interestedClients = new Set<string>()
  private lastStops = new Map<string, StopEvent>()

  constructor(private store: Store) {}

  start(): void {
    this.unsubscribeHook = onStopEvent((ev) => this.handleStop(ev))
    this.unsubscribeStore = this.store.subscribe((event) =>
      this.handleStoreEvent(event)
    )
  }

  stop(): void {
    this.unsubscribeHook?.()
    this.unsubscribeHook = null
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
  }

  setClientInterested(clientId: string, expanded: boolean): void {
    const wasZero = this.interestedClients.size === 0
    if (expanded) this.interestedClients.add(clientId)
    else this.interestedClients.delete(clientId)
    if (wasZero && this.interestedClients.size > 0) this.backfillAll()
  }

  removeClient(clientId: string): void {
    this.interestedClients.delete(clientId)
  }

  private handleStop(ev: StopEvent): void {
    this.lastStops.set(ev.terminalId, ev)
    if (this.interestedClients.size === 0) return
    this.parseAndDispatchStop(ev)
  }

  private parseAndDispatchStop(ev: StopEvent): void {
    try {
      const entry = this.parseIncremental(ev.sessionId, ev.transcriptPath)
      if (!entry) return
      const usage: SessionUsage = {
        sessionId: ev.sessionId,
        transcriptPath: ev.transcriptPath,
        byModel: entry.byModel,
        breakdown: entry.breakdown,
        currentModel: entry.currentModel,
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

  private handleStoreEvent(event: StateEvent): void {
    if (
      event.type === 'jsonClaude/busyChanged' &&
      event.payload.busy === false
    ) {
      this.recordJsonModeTurnComplete(event.payload.sessionId)
      return
    }
    if (event.type === 'jsonClaude/sessionStarted') {
      this.recordJsonModeTurnComplete(event.payload.sessionId)
    }
  }

  private recordJsonModeTurnComplete(sessionId: string): void {
    if (this.interestedClients.size === 0) return
    this.parseAndDispatchJsonMode(sessionId)
  }

  /** Reparse the JSON-mode session's on-disk JSONL and dispatch fresh
   *  cost totals. Skips the dispatch when parsing yields no model data
   *  so an early reparse (resume from disk before claude has flushed)
   *  doesn't wipe an existing hydrated entry. The next reparse picks
   *  things up. */
  private parseAndDispatchJsonMode(sessionId: string): void {
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session) return
    const transcriptPath = jsonClaudeTranscriptPath(
      session.worktreePath,
      sessionId
    )
    try {
      const entry = this.parseIncremental(sessionId, transcriptPath)
      if (!entry || Object.keys(entry.byModel).length === 0) return
      const usage: SessionUsage = {
        sessionId,
        transcriptPath,
        byModel: entry.byModel,
        breakdown: entry.breakdown,
        currentModel: entry.currentModel,
        updatedAt: Date.now()
      }
      this.store.dispatch({
        type: 'costs/usageUpdated',
        payload: { terminalId: sessionId, usage }
      })
    } catch (err) {
      log(
        'cost-tracker',
        `failed to ingest json-claude ${transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  private backfillAll(): void {
    for (const ev of this.lastStops.values()) this.parseAndDispatchStop(ev)
    const sessions = this.store.getSnapshot().state.jsonClaude.sessions
    for (const sessionId of Object.keys(sessions)) {
      this.parseAndDispatchJsonMode(sessionId)
    }
  }

  private parseIncremental(sessionId: string, path: string): CacheEntry | null {
    let entry = this.cache.get(sessionId)
    if (!entry) {
      entry = newCacheEntry()
      this.cache.set(sessionId, entry)
    }

    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      return entry
    }

    if (text.length < entry.charOffset) {
      // Transcript was truncated or replaced — reset accumulators in place.
      resetCacheEntry(entry)
    }

    if (text.length === entry.charOffset) return entry

    const newChars = text.slice(entry.charOffset)
    // The new chunk may end mid-line; only fold complete lines and let
    // the next call re-read the trailing partial from disk.
    const lastNewline = newChars.lastIndexOf('\n')
    if (lastNewline === -1) return entry

    const completeChars = newChars.slice(0, lastNewline)

    if (entry.format === null) {
      const firstLine = completeChars.split('\n').find((l) => l.trim())
      if (firstLine) entry.format = detectFormat(firstLine)
    }

    if (entry.format === 'codex') {
      foldCodexLines(completeChars, entry)
    } else if (entry.format === 'claude') {
      foldClaudeLines(completeChars, entry)
    }

    entry.charOffset += lastNewline + 1
    return entry
  }
}

function jsonClaudeTranscriptPath(worktreePath: string, sessionId: string): string {
  return join(
    homedir(),
    '.claude',
    'projects',
    worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`
  )
}

function detectFormat(firstLine: string): 'claude' | 'codex' {
  try {
    const first = JSON.parse(firstLine) as Record<string, unknown>
    if (
      first.type === 'session_meta' ||
      first.type === 'event_msg' ||
      first.type === 'response_item' ||
      first.type === 'turn_context'
    ) {
      return 'codex'
    }
  } catch {
    /* fall through to claude */
  }
  return 'claude'
}

function foldClaudeLines(text: string, entry: CacheEntry): void {
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
      handleUserMessage(obj, entry.ctx, entry.toolNameById)
      continue
    }
    if (type === 'assistant') {
      const model = handleAssistantMessage(
        obj,
        entry.ctx,
        entry.toolNameById,
        entry.byModel,
        entry.breakdown
      )
      if (model) entry.currentModel = model
    }
  }
}

function foldCodexLines(text: string, entry: CacheEntry): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (obj.type === 'turn_context') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload && typeof payload.model === 'string') {
        entry.currentModel = payload.model
      }
    }

    if (obj.type === 'event_msg') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload?.type !== 'token_count') continue
      const info = payload.info as Record<string, unknown> | undefined
      const lastUsage = info?.last_token_usage as Record<string, unknown> | undefined
      if (!lastUsage || !entry.currentModel) continue

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
      const cost = priceFor(entry.currentModel, usage)

      const tally = (entry.byModel[entry.currentModel] ??= { ...emptyTally })
      tally.messages += 1
      tally.input += inputTokens
      tally.output += outputTokens
      tally.cacheRead += cachedInputTokens
      tally.cost += cost

      entry.breakdown.text += cost
    }
  }
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
