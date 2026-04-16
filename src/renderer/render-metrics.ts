export interface RenderSample {
  t: number
  commits: number
  totalDurationMs: number
  maxDurationMs: number
}

const HISTORY_SIZE = 120

// Singleton — a single <Profiler> at the root funnels every commit's
// actualDuration through record(). The timer below snapshots 1-second
// buckets (matching the main-process PerfMonitor cadence) so the HUD can
// align them by array index.
class RenderMetrics {
  private commitCount = 0
  private totalDuration = 0
  private maxDuration = 0
  private history: RenderSample[] = []
  private head = 0
  private len = 0
  private latest: RenderSample = {
    t: 0,
    commits: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  }

  constructor() {
    setInterval(() => {
      const sample: RenderSample = {
        t: Date.now(),
        commits: this.commitCount,
        totalDurationMs: Math.round(this.totalDuration * 100) / 100,
        maxDurationMs: Math.round(this.maxDuration * 100) / 100,
      }
      this.latest = sample
      this.push(sample)
      this.commitCount = 0
      this.totalDuration = 0
      this.maxDuration = 0
    }, 1000)
  }

  record(actualDuration: number): void {
    this.commitCount++
    this.totalDuration += actualDuration
    if (actualDuration > this.maxDuration) this.maxDuration = actualDuration
  }

  getLatest(): RenderSample {
    return this.latest
  }

  getHistory(): RenderSample[] {
    const out: RenderSample[] = []
    for (let i = 0; i < this.len; i++) {
      out.push(this.history[(this.head + i) % HISTORY_SIZE])
    }
    return out
  }

  private push(s: RenderSample): void {
    if (this.len < HISTORY_SIZE) {
      this.history[this.len] = s
      this.len++
    } else {
      this.history[this.head] = s
      this.head = (this.head + 1) % HISTORY_SIZE
    }
  }
}

export const renderMetrics = new RenderMetrics()
