// Follows the transcript of a background sub-agent (Task/Agent launched
// with run_in_background: true) and republishes its activity as chat
// entries on the parent session.
//
// Why this exists: a synchronous sub-agent streams its work inline on the
// parent's stream-json, tagged with parent_tool_use_id, so the renderer's
// existing nesting picks it up for free. A background agent doesn't — the
// parent's Task tool_result resolves instantly with a launch stub and the
// real work goes to a side transcript. Tailing that file and stamping the
// launching tool_use id onto each entry puts background agents back on the
// same rendering path as synchronous ones.
//
// The launch stub tells the model "do NOT read this file" because dumping
// a full sub-agent transcript into an LLM context would blow it up. That
// warning is aimed at the model, not at us — parsing it in main and
// rendering it as UI is exactly what it's for.

import { existsSync, watch, type FSWatcher } from 'fs'
import { open, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { JsonClaudeChatEntry } from '../shared/state/json-claude'
import { log } from './debug'
import { parseTranscriptEntries } from './transcript-entries'

/** Debounce for fs.watch bursts. A single appended line can fire several
 *  change events; batching them keeps us from re-reading per byte. */
const READ_DEBOUNCE_MS = 120

/** Safety valve on a single incremental read. Sub-agent transcripts are
 *  usually well under this; a pathological one shouldn't be able to push
 *  an unbounded string through the reducer in one dispatch. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

export interface SubagentTailHandle {
  sessionId: string
  toolUseId: string
  agentId: string
  path: string
}

interface ActiveTail extends SubagentTailHandle {
  watcher: FSWatcher | null
  /** Byte offset already consumed. Reads resume from here. */
  offset: number
  /** Trailing bytes of a partial final line, prepended to the next read. */
  carry: string
  /** entryId counter, carried across chunks so ids stay unique. */
  counter: number
  timer: NodeJS.Timeout | null
  reading: boolean
  /** Set once the completion notification lands; the next drain is final. */
  finishing: boolean
  disposed: boolean
}

export interface AsyncLaunch {
  agentId: string
  outputFile?: string
}

/** Recognize the Task tool_result that announces a detached agent. The
 *  payload is prose with two machine-readable lines:
 *
 *    Async agent launched successfully.
 *    agentId: aece96b04cf6ba1c8 (internal ID - do not mention to user. …)
 *    output_file: /private/tmp/claude-501/…/tasks/aece96b04cf6ba1c8.output
 *
 *  Matching the agentId line alone would risk false positives on any tool
 *  result that happens to mention one, so we also require either the
 *  announcement sentence or the output_file line. */
export function parseAsyncLaunch(content: string): AsyncLaunch | null {
  const agentId = /^\s*agentId:\s*([A-Za-z0-9_-]+)/m.exec(content)?.[1]
  if (!agentId) return null
  const outputFile = /^\s*output_file:\s*(\S.*?)\s*$/m.exec(content)?.[1]
  const announced = /async agent launched/i.test(content)
  if (!announced && !outputFile) return null
  return { agentId, ...(outputFile ? { outputFile } : {}) }
}

export interface TaskNotification {
  taskId: string
  toolUseId?: string
  status: string
  summary?: string
  result?: string
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
}

function tagText(source: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source)
  return m ? m[1].trim() : undefined
}

function tagNumber(source: string, tag: string): number | undefined {
  const raw = tagText(source, tag)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** Parse the completion notification the runtime injects as a synthetic
 *  user turn on the parent session once a background agent finishes. */
export function parseTaskNotification(text: string): TaskNotification | null {
  const block = /<task-notification>[\s\S]*?<\/task-notification>/.exec(text)?.[0]
  if (!block) return null
  const taskId = tagText(block, 'task-id')
  if (!taskId) return null
  const usageBlock = tagText(block, 'usage')
  const usage = usageBlock
    ? {
        totalTokens: tagNumber(usageBlock, 'total_tokens'),
        toolUses: tagNumber(usageBlock, 'tool_uses'),
        durationMs: tagNumber(usageBlock, 'duration_ms')
      }
    : undefined
  return {
    taskId,
    toolUseId: tagText(block, 'tool-use-id'),
    status: tagText(block, 'status') ?? 'completed',
    summary: tagText(block, 'summary'),
    result: tagText(block, 'result'),
    ...(usage ? { usage } : {})
  }
}

/** Location of a background sub-agent's transcript. The launch stub gives
 *  a /tmp path, but that's a symlink into the session's own project dir —
 *  we derive the real path so a /tmp sweep can't break tailing. */
export function subagentTranscriptPath(
  sessionId: string,
  worktreePath: string,
  agentId: string
): string {
  return join(
    homedir(),
    '.claude',
    'projects',
    worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`
  )
}

export class SubagentTailer {
  private tails = new Map<string, ActiveTail>()
  private onEntries: (sessionId: string, entries: JsonClaudeChatEntry[]) => void

  constructor(
    onEntries: (sessionId: string, entries: JsonClaudeChatEntry[]) => void
  ) {
    this.onEntries = onEntries
  }

  private key(sessionId: string, toolUseId: string): string {
    return `${sessionId}::${toolUseId}`
  }

  /** Begin following `agentId`'s transcript. Idempotent per
   *  (sessionId, toolUseId) so a replayed launch record can't double-tail.
   *  The file may not exist yet — the agent is spawning — so we poll on a
   *  short timer until it appears, then switch to fs.watch. */
  start(opts: {
    sessionId: string
    worktreePath: string
    toolUseId: string
    agentId: string
    /** outputFile from the launch stub. Used only as a fallback when the
     *  derived project-dir path doesn't exist. */
    fallbackPath?: string
  }): void {
    const key = this.key(opts.sessionId, opts.toolUseId)
    if (this.tails.has(key)) return

    const derived = subagentTranscriptPath(
      opts.sessionId,
      opts.worktreePath,
      opts.agentId
    )
    const path =
      !existsSync(derived) && opts.fallbackPath && existsSync(opts.fallbackPath)
        ? opts.fallbackPath
        : derived

    const tail: ActiveTail = {
      sessionId: opts.sessionId,
      toolUseId: opts.toolUseId,
      agentId: opts.agentId,
      path,
      watcher: null,
      offset: 0,
      carry: '',
      counter: 0,
      timer: null,
      reading: false,
      finishing: false,
      disposed: false
    }
    this.tails.set(key, tail)
    log(
      'json-claude',
      `subagent tail start session=${opts.sessionId} agent=${opts.agentId} path=${path}`
    )
    this.attach(tail)
  }

  /** Mark the agent finished. Drains whatever is left on disk, then tears
   *  the watcher down. Called when the parent receives the completion
   *  notification. */
  finish(sessionId: string, toolUseId: string): void {
    const tail = this.tails.get(this.key(sessionId, toolUseId))
    if (!tail) return
    tail.finishing = true
    void this.drain(tail)
  }

  stopSession(sessionId: string): void {
    for (const [key, tail] of this.tails) {
      if (tail.sessionId !== sessionId) continue
      this.teardown(tail)
      this.tails.delete(key)
    }
  }

  dispose(): void {
    for (const tail of this.tails.values()) this.teardown(tail)
    this.tails.clear()
  }

  private teardown(tail: ActiveTail): void {
    tail.disposed = true
    if (tail.timer) {
      clearTimeout(tail.timer)
      tail.timer = null
    }
    tail.watcher?.close()
    tail.watcher = null
  }

  /** Wire fs.watch once the file exists, retrying on a timer until then.
   *  fs.watch on a not-yet-created path throws ENOENT rather than firing
   *  when it appears, so the wait has to be a poll. */
  private attach(tail: ActiveTail): void {
    if (tail.disposed) return
    if (!existsSync(tail.path)) {
      tail.timer = setTimeout(() => this.attach(tail), READ_DEBOUNCE_MS * 2)
      return
    }
    try {
      tail.watcher = watch(tail.path, () => this.schedule(tail))
    } catch (err) {
      log(
        'json-claude',
        `subagent watch failed agent=${tail.agentId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
    void this.drain(tail)
  }

  private schedule(tail: ActiveTail): void {
    if (tail.disposed || tail.timer) return
    tail.timer = setTimeout(() => {
      tail.timer = null
      void this.drain(tail)
    }, READ_DEBOUNCE_MS)
  }

  /** Read everything appended since the last offset, parse the complete
   *  lines, and publish. Re-entrancy guarded because fs.watch can fire
   *  again mid-read. */
  private async drain(tail: ActiveTail): Promise<void> {
    if (tail.reading) return
    if (tail.disposed && !tail.finishing) return
    tail.reading = true
    try {
      const info = await stat(tail.path).catch(() => null)
      if (!info) return
      // The transcript is append-only; a smaller size means it was
      // replaced (agent restarted, dir recycled). Start over rather than
      // reading from a stale offset into the middle of a line.
      if (info.size < tail.offset) {
        tail.offset = 0
        tail.carry = ''
      }
      while (tail.offset < info.size) {
        const want = Math.min(info.size - tail.offset, MAX_CHUNK_BYTES)
        const handle = await open(tail.path, 'r')
        let chunk: string
        try {
          const buf = Buffer.alloc(want)
          const { bytesRead } = await handle.read(buf, 0, want, tail.offset)
          if (bytesRead <= 0) break
          tail.offset += bytesRead
          chunk = buf.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close()
        }
        const combined = tail.carry + chunk
        const lastNewline = combined.lastIndexOf('\n')
        if (lastNewline === -1) {
          tail.carry = combined
          continue
        }
        tail.carry = combined.slice(lastNewline + 1)
        const complete = combined.slice(0, lastNewline)
        const { entries, nextCounter } = parseTranscriptEntries(complete, {
          idPrefix: `${tail.sessionId}-bg-${tail.agentId}`,
          counterStart: tail.counter,
          parentToolUseId: tail.toolUseId,
          skipPlainUserText: true
        })
        tail.counter = nextCounter
        if (entries.length > 0) this.onEntries(tail.sessionId, entries)
      }
    } catch (err) {
      log(
        'json-claude',
        `subagent drain failed agent=${tail.agentId}`,
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      tail.reading = false
      if (tail.finishing && !tail.disposed) {
        this.teardown(tail)
        this.tails.delete(this.key(tail.sessionId, tail.toolUseId))
        log('json-claude', `subagent tail done agent=${tail.agentId}`)
      }
    }
  }
}
