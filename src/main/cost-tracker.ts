// CostTracker subscribes to Stop hook events, tails the session jsonl
// pointed at by `transcript_path`, sums per-model usage, and dispatches
// costs/usageUpdated through the store. The renderer mirrors it via
// `useCosts()` — see CLAUDE.md "main owns state, renderer mirrors".
//
// Tailing is offset-based, keyed by transcriptPath (not terminalId), so
// if a tab is restarted with `--resume <sessionId>` against the same
// jsonl we don't double-count. Only delta bytes since the last read are
// parsed and applied.

import { openSync, fstatSync, readSync, closeSync } from 'fs'
import type { Store } from './store'
import { onStopEvent, type StopEvent } from './hooks'
import {
  emptyTally,
  type ModelTally,
  type SessionUsage
} from '../shared/state/costs'
import { priceFor, isKnownModel, type TokenUsage } from '../shared/pricing'
import { log } from './debug'

interface Offset {
  bytes: number
  residual: string
}

export class CostTracker {
  private offsets = new Map<string, Offset>()
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
      this.ingestTranscript(ev)
    } catch (err) {
      log(
        'cost-tracker',
        `failed to ingest ${ev.transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  private ingestTranscript(ev: StopEvent): void {
    const path = ev.transcriptPath
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    let delta: { tally: Record<string, ModelTally>; lastModel: string | null }
    try {
      const { size } = fstatSync(fd)
      const prior = this.offsets.get(path) ?? { bytes: 0, residual: '' }
      let start = prior.bytes
      let residual = prior.residual
      if (size < start) {
        start = 0
        residual = ''
      }
      if (size === start) {
        closeSync(fd)
        return
      }
      const len = size - start
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, start)
      this.offsets.set(path, { bytes: size, residual: '' })
      delta = this.parseDelta(residual + buf.toString('utf-8'), path)
    } finally {
      closeSync(fd)
    }

    const existing = this.store.getSnapshot().state.costs.byTerminal[ev.terminalId]
    const merged = mergeUsage(existing, ev, delta)
    this.store.dispatch({
      type: 'costs/usageUpdated',
      payload: { terminalId: ev.terminalId, usage: merged }
    })
  }

  private parseDelta(
    text: string,
    path: string
  ): { tally: Record<string, ModelTally>; lastModel: string | null } {
    const lines = text.split('\n')
    // Last chunk may be partial; stash for next read.
    const tail = lines.pop() ?? ''
    if (tail) this.offsets.get(path)!.residual = tail

    const tally: Record<string, ModelTally> = {}
    let lastModel: string | null = null
    for (const line of lines) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (obj.type !== 'assistant') continue
      const msg = obj.message as Record<string, unknown> | undefined
      if (!msg) continue
      const model = typeof msg.model === 'string' ? msg.model : null
      const usage = (msg.usage ?? null) as TokenUsage | null
      if (!model || !usage) continue
      if (!isKnownModel(model)) {
        log('cost-tracker', `unknown model: ${model}`)
      }
      lastModel = model
      const t = (tally[model] ??= { ...emptyTally })
      t.messages += 1
      t.input += usage.input_tokens ?? 0
      t.output += usage.output_tokens ?? 0
      t.cacheRead += usage.cache_read_input_tokens ?? 0
      t.cacheWrite += usage.cache_creation_input_tokens ?? 0
      t.cost += priceFor(model, usage)
    }
    return { tally, lastModel }
  }
}

function mergeUsage(
  existing: SessionUsage | undefined,
  ev: StopEvent,
  delta: { tally: Record<string, ModelTally>; lastModel: string | null }
): SessionUsage {
  const byModel: Record<string, ModelTally> = existing ? { ...existing.byModel } : {}
  for (const [model, t] of Object.entries(delta.tally)) {
    const prev = byModel[model] ?? { ...emptyTally }
    byModel[model] = {
      messages: prev.messages + t.messages,
      input: prev.input + t.input,
      output: prev.output + t.output,
      cacheRead: prev.cacheRead + t.cacheRead,
      cacheWrite: prev.cacheWrite + t.cacheWrite,
      cost: prev.cost + t.cost
    }
  }
  return {
    sessionId: ev.sessionId,
    transcriptPath: ev.transcriptPath,
    byModel,
    currentModel: delta.lastModel ?? existing?.currentModel ?? null,
    updatedAt: ev.ts * 1000
  }
}
