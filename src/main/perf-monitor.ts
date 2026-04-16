import type { Store } from './store'

export interface PerfMetrics {
  storeEventsPerSec: number
  recentEventTypes: string[]
  ipcMessagesPerSec: number
  terminalBytesPerSec: Record<string, number>
  totalTerminalBytesPerSec: number
  activePtyCount: number
  eventLoopLagMs: number
  memoryMB: { rss: number; heapUsed: number; heapTotal: number }
  uptimeSeconds: number
}

const EVENT_HISTORY_SIZE = 50
const LAG_CHECK_INTERVAL_MS = 500

export class PerfMonitor {
  private storeEventCount = 0
  private storeEventsPerSec = 0
  private recentEventTypes: string[] = []

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

  private activePtyCountFn: (() => number) | null = null
  private unsubscribe: (() => void) | null = null

  start(store: Store, getActivePtyCount: () => number): void {
    this.activePtyCountFn = getActivePtyCount
    this.startTime = Date.now()

    this.unsubscribe = store.subscribe((event) => {
      this.storeEventCount++
      this.recentEventTypes.push(event.type)
      if (this.recentEventTypes.length > EVENT_HISTORY_SIZE) {
        this.recentEventTypes.shift()
      }
    })

    // Rate calculation — every 1 second, snapshot the counters and reset
    this.rateTimer = setInterval(() => {
      this.storeEventsPerSec = this.storeEventCount
      this.storeEventCount = 0

      this.ipcMessagesPerSec = this.ipcMessageCount
      this.ipcMessageCount = 0

      let total = 0
      const snapshot: Record<string, number> = {}
      for (const [id, bytes] of Object.entries(this.terminalBytes)) {
        snapshot[id] = bytes
        total += bytes
      }
      this.terminalBytesPerSec = snapshot
      this.totalTerminalBytesPerSec = total
      this.terminalBytes = {}
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
      recentEventTypes: [...this.recentEventTypes],
      ipcMessagesPerSec: this.ipcMessagesPerSec,
      terminalBytesPerSec: { ...this.terminalBytesPerSec },
      totalTerminalBytesPerSec: this.totalTerminalBytesPerSec,
      activePtyCount: this.activePtyCountFn?.() ?? 0,
      eventLoopLagMs: this.eventLoopLagMs,
      memoryMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
      },
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
    }
  }

  stop(): void {
    if (this.rateTimer) clearInterval(this.rateTimer)
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.unsubscribe?.()
  }
}
