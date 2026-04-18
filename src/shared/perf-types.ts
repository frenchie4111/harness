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
