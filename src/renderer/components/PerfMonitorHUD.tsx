import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { PerfMetrics, PerfSample } from '../types'

const COLOR_SUCCESS = '#4ade80'
const COLOR_WARNING = '#fbbf24'
const COLOR_ERROR = '#f87171'
const COLOR_NEUTRAL = '#9ca3af'

function statusColor(value: number, green: number, amber: number): string {
  if (value < green) return 'text-success'
  if (value < amber) return 'text-warning'
  return 'text-error'
}

function statusColorHex(value: number, green: number, amber: number): string {
  if (value < green) return COLOR_SUCCESS
  if (value < amber) return COLOR_WARNING
  return COLOR_ERROR
}

function fpsColor(fps: number): string {
  if (fps >= 50) return 'text-success'
  if (fps >= 30) return 'text-warning'
  return 'text-error'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${seconds % 60}s`
}

type WindowMode = '1s' | '10s'

function downsample(samples: PerfSample[], bucketSize: number): PerfSample[] {
  if (bucketSize <= 1 || samples.length === 0) return samples
  const out: PerfSample[] = []
  for (let i = 0; i < samples.length; i += bucketSize) {
    const bucket = samples.slice(i, i + bucketSize)
    if (bucket.length === 0) continue
    const n = bucket.length
    const mergedEventCounts: Record<string, number> = {}
    let storeSum = 0
    let ipcSum = 0
    let termSum = 0
    let lagSum = 0
    let rssSum = 0
    let heapUsedSum = 0
    let heapTotalSum = 0
    for (const s of bucket) {
      storeSum += s.storeEventsPerSec
      ipcSum += s.ipcMessagesPerSec
      termSum += s.totalTerminalBytesPerSec
      lagSum += s.eventLoopLagMs
      rssSum += s.memoryRssMB
      heapUsedSum += s.memoryHeapUsedMB
      heapTotalSum += s.memoryHeapTotalMB
      for (const [k, v] of Object.entries(s.eventTypeCounts)) {
        mergedEventCounts[k] = (mergedEventCounts[k] || 0) + v
      }
    }
    // Averages across the bucket — each source sample is already a /sec rate,
    // so the average is still in units of /sec.
    const avgEventCounts: Record<string, number> = {}
    for (const [k, v] of Object.entries(mergedEventCounts)) {
      avgEventCounts[k] = v / n
    }
    out.push({
      t: bucket[bucket.length - 1].t,
      storeEventsPerSec: storeSum / n,
      ipcMessagesPerSec: ipcSum / n,
      totalTerminalBytesPerSec: termSum / n,
      eventLoopLagMs: lagSum / n,
      memoryRssMB: rssSum / n,
      memoryHeapUsedMB: heapUsedSum / n,
      memoryHeapTotalMB: heapTotalSum / n,
      eventTypeCounts: avgEventCounts,
    })
  }
  return out
}

function aggregateEventTypes(
  samples: PerfSample[]
): Array<{ type: string; perSec: number }> {
  if (samples.length === 0) return []
  const totals = new Map<string, number>()
  for (const s of samples) {
    for (const [type, count] of Object.entries(s.eventTypeCounts)) {
      totals.set(type, (totals.get(type) || 0) + count)
    }
  }
  return Array.from(totals.entries())
    .map(([type, count]) => ({ type, perSec: count / samples.length }))
    .filter((e) => e.perSec > 0)
    .sort((a, b) => b.perSec - a.perSec)
}

function formatPerSec(value: number): string {
  if (value >= 10) return `${value.toFixed(0)}/s`
  if (value >= 1) return `${value.toFixed(1)}/s`
  return `${value.toFixed(2)}/s`
}

interface SparklineProps {
  data: number[]
  color: string
  width?: number
  height?: number
}

function Sparkline({
  data,
  color,
  width = 72,
  height = 16,
}: SparklineProps): JSX.Element {
  if (data.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        style={{ display: 'block', opacity: 0.3 }}
      >
        <line
          x1={0}
          x2={width}
          y1={height - 1}
          y2={height - 1}
          stroke={color}
          strokeWidth={1}
        />
      </svg>
    )
  }
  const max = Math.max(...data, 1)
  const stepX = width / (data.length - 1)
  const points = data
    .map((v, i) => {
      const x = i * stepX
      const y = height - 1 - (v / max) * (height - 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1} />
    </svg>
  )
}

interface Props {
  onClose: () => void
}

export function PerfMonitorHUD({ onClose }: Props): JSX.Element {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null)
  const [fps, setFps] = useState(60)
  const [rendererMemoryMB, setRendererMemoryMB] = useState(0)
  const [windowMode, setWindowMode] = useState<WindowMode>('1s')
  const frameCountRef = useRef(0)
  const lastFpsTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  useEffect(() => {
    let running = true
    const tick = (): void => {
      if (!running) return
      frameCountRef.current++
      const now = performance.now()
      const elapsed = now - lastFpsTimeRef.current
      if (elapsed >= 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / elapsed))
        frameCountRef.current = 0
        lastFpsTimeRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    let active = true
    const poll = async (): Promise<void> => {
      if (!active) return
      try {
        const m = await window.api.getPerfMetrics()
        if (active) setMetrics(m)
      } catch {
        // ignore
      }
    }
    void poll()
    const timer = setInterval(poll, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const update = (): void => {
      const perf = performance as { memory?: { usedJSHeapSize: number } }
      if (perf.memory) {
        setRendererMemoryMB(Math.round(perf.memory.usedJSHeapSize / 1024 / 1024))
      }
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [])

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
    },
    [onClose]
  )

  const windowed = useMemo(() => {
    const history = metrics?.history ?? []
    return windowMode === '10s' ? downsample(history, 10) : history
  }, [metrics, windowMode])

  const eventRows = useMemo(() => aggregateEventTypes(windowed), [windowed])

  const storeSeries = windowed.map((s) => s.storeEventsPerSec)
  const ipcSeries = windowed.map((s) => s.ipcMessagesPerSec)
  const termSeries = windowed.map((s) => s.totalTerminalBytesPerSec)
  const lagSeries = windowed.map((s) => s.eventLoopLagMs)
  const memSeries = windowed.map((s) => s.memoryRssMB)

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 360,
        zIndex: 9999,
        pointerEvents: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: '18px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: '#e0e0e0',
        borderRadius: 8,
        border: '1px solid rgba(255, 255, 255, 0.1)',
        overflow: 'hidden',
        backdropFilter: 'blur(8px)',
      }}
      tabIndex={-1}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: '#999',
        }}
      >
        <span>Performance</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <WindowToggle mode={windowMode} onChange={setWindowMode} />
          <button
            onClick={handleClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#999',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '0 2px',
            }}
            tabIndex={-1}
          >
            &times;
          </button>
        </div>
      </div>

      <div style={{ padding: '4px 10px 6px' }}>
        <Row label="FPS" value={String(fps)} valueClassName={fpsColor(fps)} />
        <Row
          label="Event loop"
          value={metrics ? `${metrics.eventLoopLagMs}ms` : '—'}
          valueClassName={metrics ? statusColor(metrics.eventLoopLagMs, 10, 50) : ''}
          sparkData={lagSeries}
          sparkColor={
            metrics ? statusColorHex(metrics.eventLoopLagMs, 10, 50) : COLOR_NEUTRAL
          }
        />
        <Row
          label="Store events"
          value={metrics ? `${metrics.storeEventsPerSec}/sec` : '—'}
          valueClassName={
            metrics ? statusColor(metrics.storeEventsPerSec, 20, 100) : ''
          }
          sparkData={storeSeries}
          sparkColor={
            metrics
              ? statusColorHex(metrics.storeEventsPerSec, 20, 100)
              : COLOR_NEUTRAL
          }
        />
        <Row
          label="IPC messages"
          value={metrics ? `${metrics.ipcMessagesPerSec}/sec` : '—'}
          valueClassName={
            metrics ? statusColor(metrics.ipcMessagesPerSec, 30, 150) : ''
          }
          sparkData={ipcSeries}
          sparkColor={
            metrics
              ? statusColorHex(metrics.ipcMessagesPerSec, 30, 150)
              : COLOR_NEUTRAL
          }
        />
        <Row
          label="Terminal data"
          value={metrics ? formatBytes(metrics.totalTerminalBytesPerSec) : '—'}
          valueClassName={
            metrics
              ? statusColor(metrics.totalTerminalBytesPerSec, 100 * 1024, 1024 * 1024)
              : ''
          }
          sparkData={termSeries}
          sparkColor={
            metrics
              ? statusColorHex(
                  metrics.totalTerminalBytesPerSec,
                  100 * 1024,
                  1024 * 1024
                )
              : COLOR_NEUTRAL
          }
        />
        <Row
          label="Active PTYs"
          value={metrics ? String(metrics.activePtyCount) : '—'}
          valueClassName=""
        />
        <Row
          label="Memory (main)"
          value={metrics ? `${metrics.memoryMB.rss} MB` : '—'}
          valueClassName={metrics ? statusColor(metrics.memoryMB.rss, 200, 500) : ''}
          sparkData={memSeries}
          sparkColor={
            metrics ? statusColorHex(metrics.memoryMB.rss, 200, 500) : COLOR_NEUTRAL
          }
        />
        <Row
          label="Memory (render)"
          value={`${rendererMemoryMB} MB`}
          valueClassName={statusColor(rendererMemoryMB, 200, 500)}
        />
        <Row
          label="Uptime"
          value={metrics ? formatUptime(metrics.uptimeSeconds) : '—'}
          valueClassName=""
        />

        {eventRows.length > 0 && (
          <>
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                fontSize: 10,
                color: '#777',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 2,
              }}
            >
              <span>Events by type</span>
              <span style={{ fontSize: 9, textTransform: 'none', color: '#555' }}>
                avg /sec over {windowed.length}{windowMode === '10s' ? '×10s' : 's'}
              </span>
            </div>
            <div style={{ maxHeight: 120, overflowY: 'auto' }}>
              {eventRows.slice(0, 12).map((e) => (
                <div
                  key={e.type}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '1px 0',
                  }}
                >
                  <span
                    style={{
                      color: '#aaa',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginRight: 8,
                    }}
                  >
                    {e.type}
                  </span>
                  <span
                    style={{
                      color:
                        e.perSec > 10
                          ? COLOR_ERROR
                          : e.perSec > 3
                            ? COLOR_WARNING
                            : COLOR_NEUTRAL,
                      flexShrink: 0,
                    }}
                  >
                    {formatPerSec(e.perSec)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function WindowToggle({
  mode,
  onChange,
}: {
  mode: WindowMode
  onChange: (m: WindowMode) => void
}): JSX.Element {
  const base: React.CSSProperties = {
    background: 'none',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    color: '#777',
    cursor: 'pointer',
    fontSize: 10,
    lineHeight: 1,
    padding: '2px 5px',
    fontFamily: 'inherit',
    textTransform: 'none',
    letterSpacing: 0,
  }
  const active: React.CSSProperties = {
    ...base,
    color: '#e0e0e0',
    background: 'rgba(255, 255, 255, 0.08)',
  }
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      <button
        onClick={() => onChange('1s')}
        style={mode === '1s' ? active : base}
        tabIndex={-1}
      >
        1s
      </button>
      <button
        onClick={() => onChange('10s')}
        style={mode === '10s' ? active : base}
        tabIndex={-1}
      >
        10s
      </button>
    </div>
  )
}

function Row({
  label,
  value,
  valueClassName,
  sparkData,
  sparkColor,
}: {
  label: string
  value: string
  valueClassName: string
  sparkData?: number[]
  sparkColor?: string
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1px 0',
        gap: 8,
      }}
    >
      <span style={{ color: '#999', flexShrink: 0 }}>{label}</span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        {sparkData && (
          <Sparkline data={sparkData} color={sparkColor || COLOR_NEUTRAL} />
        )}
        <span
          className={valueClassName}
          style={{ minWidth: 68, textAlign: 'right' }}
        >
          {value}
        </span>
      </div>
    </div>
  )
}
