import type { Store } from './store'
import type { PerfMetrics, PerfSample } from '../shared/perf-types'
import { perfLog } from './perf-log'

export type { PerfMetrics, PerfSample }

const HISTORY_SIZE = 120
const LAG_CHECK_INTERVAL_MS = 500
const LAG_SPIKE_THRESHOLD_MS = 100
const SNAPSHOT_INTERVAL_MS = 30000
const MICROTASK_PROBE_INTERVAL_MS = 50
const MICROTASK_DRIFT_THRESHOLD_MS = 50

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export class PerfMonitor {
  private storeEventCount = 0
  private storeEventsPerSec = 0
  private eventTypeCountsCurrent: Record<string, number> = {}

  private ipcMessageCount = 0
  private ipcMessagesPerSec = 0

  private terminalBytes: Record<string, number> = {}
  private terminalBytesPerSec: Record<string, number> = {}
  private totalTerminalBytesPerSec = 0

  private eventLoopLagMs = 0
  private lagExpected = 0
  private lagTimer: NodeJS.Timeout | null = null
  private rateTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private microtaskTimer: NodeJS.Timeout | null = null
  private microtaskLastTick = 0
  private startTime = Date.now()

  // Ring buffer: fixed capacity HISTORY_SIZE, oldest at head / newest at tail.
  private history: PerfSample[] = []
  private historyHead = 0
  private historyLen = 0

  private activePtyCountFn: (() => number) | null = null
  private unsubscribe: (() => void) | null = null

  start(store: Store, getActivePtyCount: () => number): void {
    this.activePtyCountFn = getActivePtyCount
    this.startTime = Date.now()

    this.unsubscribe = store.subscribe((event) => {
      this.storeEventCount++
      this.eventTypeCountsCurrent[event.type] =
        (this.eventTypeCountsCurrent[event.type] || 0) + 1
    })

    // Rate calculation — every 1 second, snapshot the counters, push a sample,
    // and reset.
    this.rateTimer = setInterval(() => {
      this.storeEventsPerSec = this.storeEventCount
      this.ipcMessagesPerSec = this.ipcMessageCount

      let total = 0
      const tSnapshot: Record<string, number> = {}
      for (const [id, bytes] of Object.entries(this.terminalBytes)) {
        tSnapshot[id] = bytes
        total += bytes
      }
      this.terminalBytesPerSec = tSnapshot
      this.totalTerminalBytesPerSec = total

      const mem = process.memoryUsage()
      const sample: PerfSample = {
        t: Date.now(),
        storeEventsPerSec: this.storeEventsPerSec,
        ipcMessagesPerSec: this.ipcMessagesPerSec,
        totalTerminalBytesPerSec: total,
        eventLoopLagMs: this.eventLoopLagMs,
        memoryRssMB: Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        memoryHeapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        eventTypeCounts: this.eventTypeCountsCurrent,
      }
      this.pushSample(sample)

      this.storeEventCount = 0
      this.ipcMessageCount = 0
      this.terminalBytes = {}
      this.eventTypeCountsCurrent = {}
    }, 1000)

    // Event loop lag detection
    this.lagExpected = Date.now() + LAG_CHECK_INTERVAL_MS
    this.lagTimer = setInterval(() => {
      const now = Date.now()
      this.eventLoopLagMs = Math.max(0, now - this.lagExpected)
      this.lagExpected = now + LAG_CHECK_INTERVAL_MS
      if (this.eventLoopLagMs >= LAG_SPIKE_THRESHOLD_MS) {
        perfLog('eventloop-spike', `${this.eventLoopLagMs}ms`, {
          lagMs: this.eventLoopLagMs,
          intervalMs: LAG_CHECK_INTERVAL_MS
        })
      }
    }, LAG_CHECK_INTERVAL_MS)

    // Periodic snapshot — cheap continuous trace (1 line / 30s) so we
    // can answer "what was the system doing at <timestamp>" after the fact.
    this.snapshotTimer = setInterval(() => this.writeSnapshot(), SNAPSHOT_INTERVAL_MS)

    // Higher-resolution main-thread block detector. Drift is the time
    // beyond the expected interval that elapsed before this timer fired —
    // i.e. how long the event loop was blocked on synchronous work.
    this.microtaskLastTick = performance.now()
    this.microtaskTimer = setInterval(() => {
      const now = performance.now()
      const drift = now - this.microtaskLastTick - MICROTASK_PROBE_INTERVAL_MS
      if (drift > MICROTASK_DRIFT_THRESHOLD_MS) {
        perfLog('microtask-drift', `${drift.toFixed(0)}ms`, { driftMs: +drift.toFixed(1) })
      }
      this.microtaskLastTick = now
    }, MICROTASK_PROBE_INTERVAL_MS)
  }

  private writeSnapshot(): void {
    const mem = process.memoryUsage()
    const rssMB = Math.round(mem.rss / 1024 / 1024)
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
    const ptys = this.activePtyCountFn?.() ?? 0
    const top: Array<[string, number]> = Object.entries(this.eventTypeCountsCurrent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    perfLog(
      'snapshot',
      `store=${this.storeEventsPerSec}/s ipc=${this.ipcMessagesPerSec}/s term=${formatBytes(this.totalTerminalBytesPerSec)}/s lag=${this.eventLoopLagMs}ms rss=${rssMB}MB ptys=${ptys}`,
      {
        storeEventsPerSec: this.storeEventsPerSec,
        ipcMessagesPerSec: this.ipcMessagesPerSec,
        totalTerminalBytesPerSec: this.totalTerminalBytesPerSec,
        eventLoopLagMs: this.eventLoopLagMs,
        memoryRssMB: rssMB,
        memoryHeapUsedMB: heapMB,
        activePtyCount: ptys,
        topEventTypes: Object.fromEntries(top)
      }
    )
  }

  recordIpcMessage(): void {
    this.ipcMessageCount++
  }

  recordTerminalBytes(id: string, byteCount: number): void {
    this.terminalBytes[id] = (this.terminalBytes[id] || 0) + byteCount
  }

  getMetrics(): PerfMetrics {
    const mem = process.memoryUsage()
    return {
      storeEventsPerSec: this.storeEventsPerSec,
      ipcMessagesPerSec: this.ipcMessagesPerSec,
      terminalBytesPerSec: { ...this.terminalBytesPerSec },
      totalTerminalBytesPerSec: this.totalTerminalBytesPerSec,
      activePtyCount: this.activePtyCountFn?.() ?? 0,
      eventLoopLagMs: this.eventLoopLagMs,
      memoryMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      history: this.getHistory(),
    }
  }

  getHistory(): PerfSample[] {
    const out: PerfSample[] = []
    for (let i = 0; i < this.historyLen; i++) {
      const idx = (this.historyHead + i) % HISTORY_SIZE
      out.push(this.history[idx])
    }
    return out
  }

  stop(): void {
    if (this.rateTimer) clearInterval(this.rateTimer)
    if (this.lagTimer) clearInterval(this.lagTimer)
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.microtaskTimer) clearInterval(this.microtaskTimer)
    this.unsubscribe?.()
  }

  private pushSample(sample: PerfSample): void {
    if (this.historyLen < HISTORY_SIZE) {
      this.history[this.historyLen] = sample
      this.historyLen++
    } else {
      this.history[this.historyHead] = sample
      this.historyHead = (this.historyHead + 1) % HISTORY_SIZE
    }
  }
}
