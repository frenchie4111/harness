// Reads a Claude Code session jsonl and works out what is currently
// occupying the model's context window.
//
// This is deliberately NOT the same computation as cost-tracker.ts. That
// one folds the whole transcript forward to answer "what did this session
// cost". This one answers "what is in the window right now", which means:
//
//   - only the live era counts. Everything before the last
//     `system/compact_boundary` was replaced by a summary and is gone.
//   - subagent sidechains (`isSidechain: true`) never entered the parent's
//     window, so they're excluded.
//   - several consecutive `assistant` records share one API message
//     (same `requestId`) and repeat the same `usage`. They're one turn;
//     counting them separately triples the token deltas.
//
// HOW THE NUMBERS ARE DERIVED
//
// Each assistant turn's usage record gives the exact prompt size at that
// moment:  input_tokens + cache_read + cache_creation. So:
//
//   delta_i = prompt_i - prompt_{i-1}
//
// is exactly what the content between those two turns added to the
// window. Part of that is the previous turn's own output, which we also
// know exactly (`output_tokens`); the remainder is the tool results, user
// messages and attachments that landed in between, and we split *that*
// across them by char proportion. Estimation error stays local to one
// turn instead of compounding over the session, which is the failure mode
// of a flat chars/4 pass over the whole transcript.
//
// The system prompt + tool schemas are never itemised by the API, so they
// come out as the residual: everything in the window that the message
// content doesn't account for. That falls out of the arithmetic above —
// `prompt_0` minus the content preceding the first turn — and is what
// `systemAndTools` is reconciled to at the end.
//
// Validated against a real compacted session: postTokens (10909) plus the
// measured baseline (~30.8k) reproduces the observed post-compaction
// prompt of 41780, and that baseline matches the same session's own
// first-turn baseline of 30068.

import {
  emptyCategories,
  cloneCategories,
  totalCategories,
  type ContextCategories
} from '../shared/state/context-window'
import {
  contextLimitFor,
  inferContextLimit,
  AUTOCOMPACT_FRACTION,
  CHARS_PER_TOKEN
} from '../shared/context-limits'

type Bucket =
  | 'carriedSummary'
  | 'attachments'
  | 'userPrompts'
  | 'assistantText'
  | 'thinking'
  | 'toolCalls'
  | 'toolResults'

interface Item {
  bucket: Bucket
  toolName?: string
  chars: number
  /** Index of the turn whose `output_tokens` covers this item. Set on
   *  blocks the model produced; undefined for anything fed back in. */
  ownerTurn?: number
  /** Bypasses estimation when the transcript reports the true size (the
   *  post-compaction summary, via compactMetadata.postTokens). */
  exactTokens?: number
}

interface Turn {
  promptTokens: number
  outputTokens: number
  model: string | null
  /** Content that entered the window between the previous turn and this
   *  one — including the previous turn's own output blocks. */
  items: Item[]
}

export interface ContextAnalysis {
  model: string | null
  limit: number
  usedTokens: number
  categories: ContextCategories
  autocompactAt: number
  compactions: number
  discoverableTools: string[]
  measured: boolean
}

function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

function itemEstimate(item: Item): number {
  return item.exactTokens ?? estTokens(item.chars)
}

function charLenOfContent(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (typeof p.text === 'string') total += p.text.length
      else total += JSON.stringify(p).length
    }
    return total
  }
  if (content && typeof content === 'object') return JSON.stringify(content).length
  return 0
}

function addTo(cat: ContextCategories, item: Item, tokens: number): void {
  if (tokens <= 0) return
  switch (item.bucket) {
    case 'toolResults': {
      const name = item.toolName || 'unknown'
      cat.toolResults[name] = (cat.toolResults[name] ?? 0) + tokens
      return
    }
    case 'carriedSummary':
      cat.carriedSummary += tokens
      return
    case 'attachments':
      cat.attachments += tokens
      return
    case 'userPrompts':
      cat.userPrompts += tokens
      return
    case 'assistantText':
      cat.assistantText += tokens
      return
    case 'thinking':
      cat.thinking += tokens
      return
    case 'toolCalls':
      cat.toolCalls += tokens
      return
  }
}

function scaleCategories(cat: ContextCategories, factor: number): void {
  cat.carriedSummary = Math.round(cat.carriedSummary * factor)
  cat.attachments = Math.round(cat.attachments * factor)
  cat.userPrompts = Math.round(cat.userPrompts * factor)
  cat.assistantText = Math.round(cat.assistantText * factor)
  cat.thinking = Math.round(cat.thinking * factor)
  cat.toolCalls = Math.round(cat.toolCalls * factor)
  for (const name of Object.keys(cat.toolResults)) {
    cat.toolResults[name] = Math.round(cat.toolResults[name] * factor)
  }
}

/** Split `tokens` across `items` by char proportion. Items carrying an
 *  exactTokens value are credited that value first and excluded from the
 *  proportional split. Falls back to per-item estimates when there's no
 *  measured budget to divide. */
function distribute(cat: ContextCategories, items: Item[], tokens: number | null): void {
  if (items.length === 0) return

  const exact = items.filter((i) => i.exactTokens !== undefined)
  const rest = items.filter((i) => i.exactTokens === undefined)
  for (const item of exact) addTo(cat, item, item.exactTokens as number)

  const budget =
    tokens === null
      ? null
      : tokens - exact.reduce((a, i) => a + (i.exactTokens as number), 0)

  if (budget === null || budget <= 0) {
    for (const item of rest) addTo(cat, item, estTokens(item.chars))
    return
  }

  const totalChars = rest.reduce((a, i) => a + i.chars, 0)
  if (totalChars <= 0) {
    // Measured growth with nothing to attribute it to — usually harness
    // context the transcript doesn't record as a message. Reconciliation
    // sweeps it into systemAndTools.
    return
  }
  for (const item of rest) addTo(cat, item, Math.round((budget * item.chars) / totalChars))
}

/** Pull the `deferred_tools_delta` attachments out of the raw transcript
 *  to reconstruct the set of tools that are available but NOT loaded into
 *  the window — the "still discoverable" half of the picture. Scanned
 *  across the whole file, not just the live era: the deferred set is
 *  session-scoped and survives compaction. */
function collectDeferredTools(lines: string[]): string[] {
  const deferred = new Set<string>()
  for (const line of lines) {
    if (!line.includes('deferred_tools_delta')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const att = obj.attachment as Record<string, unknown> | undefined
    if (!att || att.type !== 'deferred_tools_delta') continue
    const added = att.addedNames
    const removed = att.removedNames
    if (Array.isArray(added)) {
      for (const n of added) if (typeof n === 'string') deferred.add(n)
    }
    if (Array.isArray(removed)) {
      for (const n of removed) if (typeof n === 'string') deferred.delete(n)
    }
  }
  return [...deferred].sort()
}

/** Index of the first line belonging to the live era, plus what the last
 *  compaction recorded about itself. Located by substring match so we
 *  don't JSON.parse the dead prefix of a long transcript. */
function findEra(lines: string[]): {
  start: number
  compactions: number
  postTokens: number | null
  preTokens: number | null
} {
  let start = 0
  let compactions = 0
  let postTokens: number | null = null
  let preTokens: number | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('compact_boundary')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'system' || obj.subtype !== 'compact_boundary') continue
    compactions++
    start = i + 1
    const meta = obj.compactMetadata as Record<string, unknown> | undefined
    postTokens = typeof meta?.postTokens === 'number' ? meta.postTokens : null
    preTokens = typeof meta?.preTokens === 'number' ? meta.preTokens : null
  }
  return { start, compactions, postTokens, preTokens }
}

/**
 * @param raw            full contents of the session jsonl
 * @param memoryChars    total bytes of the CLAUDE.md files in scope, used
 *                       to carve a `memoryFiles` estimate out of the
 *                       systemAndTools residual. 0 to skip.
 */
export function analyzeContext(raw: string, memoryChars = 0): ContextAnalysis {
  const lines = raw.split('\n').filter((l) => l.trim())
  const { start, compactions, postTokens, preTokens } = findEra(lines)
  const discoverableTools = collectDeferredTools(lines)

  const turns: Turn[] = []
  let pending: Item[] = []
  const toolNameById: Record<string, string> = {}
  let currentRequestId: string | null = null
  let model: string | null = null

  // The summary carried across the last compaction opens the live era,
  // and compactMetadata told us exactly how big it is.
  let summaryPending = compactions > 0 && postTokens !== null ? postTokens : null

  for (let i = start; i < lines.length; i++) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>
    } catch {
      continue
    }
    // Subagent transcripts are interleaved into the same file but never
    // entered the parent's window.
    if (obj.isSidechain === true) continue

    const type = obj.type

    if (type === 'attachment') {
      const att = obj.attachment
      if (att) pending.push({ bucket: 'attachments', chars: JSON.stringify(att).length })
      continue
    }

    if (type === 'user') {
      const msg = obj.message as Record<string, unknown> | undefined
      if (!msg) continue
      const content = msg.content
      if (obj.isCompactSummary === true) {
        pending.push({
          bucket: 'carriedSummary',
          chars: charLenOfContent(content),
          ...(summaryPending !== null ? { exactTokens: summaryPending } : {})
        })
        summaryPending = null
        continue
      }
      if (typeof content === 'string') {
        pending.push({ bucket: 'userPrompts', chars: content.length })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as Record<string, unknown>
        if (block.type === 'text') {
          const t = block.text
          if (typeof t === 'string') pending.push({ bucket: 'userPrompts', chars: t.length })
        } else if (block.type === 'tool_result') {
          const id = block.tool_use_id as string | undefined
          pending.push({
            bucket: 'toolResults',
            toolName: (id && toolNameById[id]) || 'unknown',
            chars: charLenOfContent(block.content)
          })
        }
      }
      continue
    }

    if (type !== 'assistant') continue

    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg) continue
    if (typeof msg.model === 'string') model = msg.model

    // One API message is written as several `assistant` records, one per
    // content block, all repeating the same usage. Only the first opens
    // a turn.
    const requestId =
      (typeof obj.requestId === 'string' ? obj.requestId : null) ??
      (typeof msg.id === 'string' ? (msg.id as string) : null)
    const usage = msg.usage as Record<string, unknown> | undefined

    if (usage && requestId !== currentRequestId) {
      currentRequestId = requestId
      const input = (usage.input_tokens as number) ?? 0
      const cacheRead = (usage.cache_read_input_tokens as number) ?? 0
      const cacheWrite = (usage.cache_creation_input_tokens as number) ?? 0
      turns.push({
        promptTokens: input + cacheRead + cacheWrite,
        outputTokens: (usage.output_tokens as number) ?? 0,
        model: typeof msg.model === 'string' ? msg.model : null,
        items: pending
      })
      pending = []
    }

    const turnIndex = turns.length - 1
    const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        const t = block.text
        if (typeof t === 'string') {
          pending.push({ bucket: 'assistantText', chars: t.length, ownerTurn: turnIndex })
        }
      } else if (block.type === 'thinking') {
        // Usually 0 chars: Claude Code persists the block's signature but
        // strips its text. The tokens were still spent, so they end up
        // attributed to this turn's text / tool_use blocks instead. Kept
        // because some transcripts do retain the text.
        const t = block.thinking
        if (typeof t === 'string') {
          pending.push({ bucket: 'thinking', chars: t.length, ownerTurn: turnIndex })
        }
      } else if (block.type === 'tool_use') {
        const id = block.id as string | undefined
        const name = block.name as string | undefined
        if (id && name) toolNameById[id] = name
        pending.push({
          bucket: 'toolCalls',
          chars: JSON.stringify(block.input ?? null).length,
          ownerTurn: turnIndex
        })
      }
    }
  }

  const categories = cloneCategories(emptyCategories)
  const measured = turns.length > 0

  if (!measured) {
    // No assistant turn yet — nothing is anchored, so everything is an
    // estimate and there's no system-prompt residual to infer.
    distribute(categories, pending, null)
    const used = totalCategories(categories)
    const limit = contextLimitFor(model)
    return {
      model,
      limit,
      usedTokens: used,
      categories,
      autocompactAt: Math.round(limit * AUTOCOMPACT_FRACTION),
      compactions,
      discoverableTools,
      measured: false
    }
  }

  // Turn 0's items precede any usage record, so they can only be
  // estimated (except an exact carried summary). Their real cost is
  // implicit in prompt_0 and falls out of the reconciliation below.
  distribute(categories, turns[0].items, null)

  for (let i = 1; i < turns.length; i++) {
    const delta = turns[i].promptTokens - turns[i - 1].promptTokens
    const outTokens = turns[i - 1].outputTokens
    const produced = turns[i].items.filter((it) => it.ownerTurn === i - 1)
    const fedBack = turns[i].items.filter((it) => it.ownerTurn !== i - 1)

    // The previous turn's output is known exactly; whatever the window
    // grew beyond that came from the tool results and messages in between.
    distribute(categories, produced, outTokens)
    distribute(categories, fedBack, delta > 0 ? Math.max(0, delta - outTokens) : null)
  }

  const last = turns[turns.length - 1]
  const lastIndex = turns.length - 1
  const tailProduced = pending.filter((it) => it.ownerTurn === lastIndex)
  const tailFedBack = pending.filter((it) => it.ownerTurn !== lastIndex)
  distribute(categories, tailProduced, last.outputTokens)
  distribute(categories, tailFedBack, null)

  const tailEstimate = tailFedBack.reduce((a, i) => a + itemEstimate(i), 0)
  const usedTokens = last.promptTokens + last.outputTokens + tailEstimate

  // The per-turn deltas above give good RELATIVE weights — they capture
  // that a base64 blob costs more tokens per char than prose — but they
  // don't sum to the window on their own. Two things break the identity:
  // prior thinking blocks get stripped from context on later turns, and a
  // rewind leaves both branches in the file so some deltas go negative.
  // Left alone that drifts badly: a real 50MB session came out at 597k
  // tokens against a 200k window.
  //
  // So normalise. The window's content budget is the exact total minus
  // the baseline, and the baseline is measured once, off the first turn:
  // prompt_0 minus the content that preceded it.
  const baseline = Math.max(
    0,
    turns[0].promptTokens - turns[0].items.reduce((a, i) => a + itemEstimate(i), 0)
  )
  const contentBudget = Math.max(0, usedTokens - baseline)
  const rawAttributed = totalCategories(categories)
  if (rawAttributed > 0) scaleCategories(categories, contentBudget / rawAttributed)

  // systemAndTools is by definition everything the window holds that the
  // conversation doesn't account for: the system prompt, the tool
  // schemas, and any harness preamble. Deriving it as the residual also
  // makes the category bars sum exactly to usedTokens.
  categories.systemAndTools = Math.max(0, usedTokens - totalCategories(categories))

  // CLAUDE.md is injected into the system block, so the API never reports
  // it separately. Size it from disk and carve it out of the residual.
  if (memoryChars > 0) {
    categories.memoryFiles = Math.min(categories.systemAndTools, estTokens(memoryChars))
    categories.systemAndTools -= categories.memoryFiles
  }

  // The transcript is better evidence of the window size than the model
  // table is — the 1M beta is per-session and doesn't reliably show up in
  // the model id.
  let peak = Math.max(usedTokens, preTokens ?? 0)
  for (const t of turns) if (t.promptTokens > peak) peak = t.promptTokens
  const limit = inferContextLimit(last.model ?? model, peak)
  // A session that has already compacted told us its own trigger point,
  // which beats a guessed fraction of the window.
  const autocompactAt =
    preTokens !== null && preTokens > 0
      ? preTokens
      : Math.round(limit * AUTOCOMPACT_FRACTION)

  return {
    model: last.model ?? model,
    limit,
    usedTokens,
    categories,
    autocompactAt,
    compactions,
    discoverableTools,
    measured: true
  }
}
