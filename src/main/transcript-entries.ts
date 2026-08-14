// Parsing for Claude Code's on-disk transcript JSONL into slice entries.
//
// Two callers share this: JsonClaudeManager.seedFromTranscript (replaying
// `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl` after a restart) and
// SubagentTailer (streaming `.../<sessionId>/subagents/agent-<id>.jsonl`
// while a background agent runs). Both files use the identical record
// shape, which is also the shape the live stream-json emits — the only
// difference is that sub-agent records carry `agentId` instead of
// `parent_tool_use_id`, so the tailer forces the parent id via options.

import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../shared/state/json-claude'

export function extractAssistantBlocks(
  ev: Record<string, unknown>
): JsonClaudeMessageBlock[] {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: JsonClaudeMessageBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    const t = block['type']
    if (t === 'text' && typeof block['text'] === 'string') {
      out.push({ type: 'text', text: block['text'] as string })
    } else if (t === 'thinking') {
      out.push({
        type: 'thinking',
        text:
          typeof block['thinking'] === 'string'
            ? (block['thinking'] as string)
            : ''
      })
    } else if (t === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: typeof block['id'] === 'string' ? (block['id'] as string) : undefined,
        name: typeof block['name'] === 'string' ? (block['name'] as string) : undefined,
        input:
          block['input'] && typeof block['input'] === 'object' && !Array.isArray(block['input'])
            ? (block['input'] as Record<string, unknown>)
            : undefined
      })
    }
  }
  return out
}

export function extractToolResults(
  ev: Record<string, unknown>
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  return extractToolResultsFromArray(content)
}

export function extractToolResultsFromArray(
  content: unknown[]
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const out: Array<{ toolUseId: string; content: string; isError: boolean }> = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (b['type'] !== 'tool_result') continue
    const id = typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : ''
    if (!id) continue
    const rawContent = b['content']
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((p) => {
                if (typeof p === 'object' && p && 'text' in (p as Record<string, unknown>)) {
                  return String((p as Record<string, unknown>)['text'])
                }
                return ''
              })
              .join('\n')
          : JSON.stringify(rawContent)
    out.push({
      toolUseId: id,
      content: text,
      isError: Boolean(b['is_error'])
    })
  }
  return out
}

export interface ParseTranscriptOptions {
  /** Namespace for generated entryIds. Session transcripts pass the
   *  sessionId; sub-agent transcripts pass a per-agent prefix so ids
   *  can't collide with the parent session's. */
  idPrefix: string
  /** Where to resume the id counter. The tailer parses one file in many
   *  chunks and must not reuse ids across them. */
  counterStart?: number
  /** Stamped onto every produced entry. Sub-agent transcripts have no
   *  `parent_tool_use_id` field of their own — the linkage lives in the
   *  file path — so the caller supplies it here to drive TaskCard nesting. */
  parentToolUseId?: string
  /** Drop plain-string user messages. Set for sub-agent transcripts,
   *  whose only such record is the brief already shown on the Task card. */
  skipPlainUserText?: boolean
}

export interface ParseTranscriptResult {
  entries: JsonClaudeChatEntry[]
  nextCounter: number
}

/** Pure parser over raw JSONL text. Unparseable lines are skipped rather
 *  than aborting the batch — a partially-flushed final line is normal when
 *  tailing a file that's still being written. */
export function parseTranscriptEntries(
  raw: string,
  opts: ParseTranscriptOptions
): ParseTranscriptResult {
  const { idPrefix, parentToolUseId, skipPlainUserText } = opts
  let counter = opts.counterStart ?? 0
  const parentField = parentToolUseId ? { parentToolUseId } : {}
  const entries: JsonClaudeChatEntry[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = parsed['type']
    // The transcript contains the same user/assistant message shapes the
    // live stream emits, plus internal bookkeeping types (queue-operation,
    // attachment, ai-title, last-prompt) we ignore.
    const transcriptUuid =
      typeof parsed['uuid'] === 'string' ? (parsed['uuid'] as string) : undefined
    if (type === 'user') {
      // Skip SDK-synthetic user records that surround compactions and
      // slash-command invocations. Without this filter the seeded
      // scrollback shows the entire continuation summary as a giant
      // user bubble plus stray '<local-command-stdout>Compacted'
      // and '<command-name>/compact' echo lines.
      //   isCompactSummary  — the post-compaction continuation summary
      //   isMeta            — the '<local-command-caveat>' wrapper
      // Plus content-prefix matches for the local-command echo pair
      // ('<command-name>' / '<local-command-stdout>') which arrive
      // without isMeta but are equally not user-typed input.
      if (parsed['isCompactSummary'] === true) continue
      if (parsed['isMeta'] === true) continue
      const message = parsed['message'] as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') {
        if (skipPlainUserText) continue
        if (
          content.startsWith('<command-name>') ||
          content.startsWith('<local-command-stdout>')
        ) {
          continue
        }
        entries.push({
          kind: 'user',
          text: content,
          timestamp: Date.now(),
          entryId: `${idPrefix}-seed-u-${counter++}`,
          ...(transcriptUuid ? { transcriptUuid } : {}),
          ...parentField
        })
      } else if (Array.isArray(content)) {
        for (const r of extractToolResultsFromArray(content)) {
          entries.push({
            entryId: `${idPrefix}-tr-${r.toolUseId}-${counter++}`,
            kind: 'tool_result',
            timestamp: Date.now(),
            ...(transcriptUuid ? { transcriptUuid } : {}),
            ...parentField,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: r.toolUseId,
                content: r.content,
                isError: r.isError
              }
            ]
          })
        }
      }
    } else if (type === 'assistant') {
      const blocks = extractAssistantBlocks(parsed)
      if (blocks.length === 0) continue
      // Same envelope shape as the live stream — parent_tool_use_id
      // is at the top level of the record, not on the inner message.
      const ownParent =
        typeof parsed['parent_tool_use_id'] === 'string'
          ? (parsed['parent_tool_use_id'] as string)
          : undefined
      const innerMessage = parsed['message'] as { id?: unknown } | undefined
      const apiMessageId =
        typeof innerMessage?.id === 'string'
          ? (innerMessage.id as string)
          : undefined
      const resolvedParent = parentToolUseId ?? ownParent
      entries.push({
        kind: 'assistant',
        blocks,
        timestamp: Date.now(),
        entryId: `${idPrefix}-seed-a-${counter++}`,
        ...(transcriptUuid ? { transcriptUuid } : {}),
        ...(apiMessageId ? { apiMessageId } : {}),
        ...(resolvedParent ? { parentToolUseId: resolvedParent } : {})
      })
    } else if (type === 'system' && parsed['subtype'] === 'compact_boundary') {
      const meta = parsed['compactMetadata'] as
        | { trigger?: unknown; preTokens?: unknown; postTokens?: unknown }
        | undefined
      const trigger =
        meta?.trigger === 'auto' || meta?.trigger === 'manual'
          ? meta.trigger
          : undefined
      const preTokens =
        typeof meta?.preTokens === 'number' ? meta.preTokens : undefined
      const postTokens =
        typeof meta?.postTokens === 'number' ? meta.postTokens : undefined
      entries.push({
        kind: 'compact',
        timestamp: Date.now(),
        entryId: `${idPrefix}-seed-c-${counter++}`,
        ...(transcriptUuid ? { transcriptUuid } : {}),
        ...parentField,
        ...(trigger ? { compactTrigger: trigger } : {}),
        ...(typeof preTokens === 'number'
          ? { compactPreTokens: preTokens }
          : {}),
        ...(typeof postTokens === 'number'
          ? { compactPostTokens: postTokens }
          : {})
      })
    }
  }
  return { entries, nextCounter: counter }
}
