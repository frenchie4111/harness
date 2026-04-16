import type { Store } from './store'

export interface PerfSample {
  t: number
  storeEventsPerSec: number
  ipcMessagesPerSec: number
  totalTerminalBytesPerSec: number
  eventLoopLagMs: number
  memoryRssMB: number
  memoryHeapUsedMB: number
  memoryHeapTotalMB: number
  eventTypeCounts: Record<string, number>
}

export interface PerfMetrics {
  storeEventsPerSec: number
  ipcMessagesPerSec: number
  terminalBytesPerSec: Record<string, number>
  totalTerminalBytesPerSec: number
  activePtyCount: number
  eventLoopLagMs: number
  memoryMB: { rss: number; heapUsed: number; heapTotal: number }
  uptimeSeconds: number
  history: PerfSample[]
}

const HISTORY_SIZE = 120
const LAG_CHECK_INTERVAL_MS = 500

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
    }, LAG_CHECK_INTERVAL_MS)
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
