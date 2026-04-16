import { useState, useEffect, useRef, useCallback } from 'react'
import type { PerfMetrics } from '../types'

function statusColor(value: number, green: number, amber: number): string {
  if (value < green) return 'text-success'
  if (value < amber) return 'text-warning'
  return 'text-error'
}

function fpsColor(fps: number): string {
  if (fps >= 50) return 'text-success'
  if (fps >= 30) return 'text-warning'
  return 'text-error'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${seconds % 60}s`
}

function dedupeEventTypes(types: string[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of types) {
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

interface Props {
  onClose: () => void
}

export function PerfMonitorHUD({ onClose }: Props): JSX.Element {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null)
  const [fps, setFps] = useState(60)
  const [rendererMemoryMB, setRendererMemoryMB] = useState(0)
  const frameCountRef = useRef(0)
  const lastFpsTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  // FPS counter via requestAnimationFrame
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

  // Poll main-process metrics every 1 second
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

  // Renderer memory (Chrome-only API)
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

  const recentEvents = metrics ? dedupeEventTypes(metrics.recentEventTypes) : []

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 320,
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
      {/* Header */}
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

      {/* Metrics rows */}
      <div style={{ padding: '4px 10px 6px' }}>
        <Row label="FPS" value={String(fps)} className={fpsColor(fps)} />
        <Row
          label="Event loop"
          value={metrics ? `${metrics.eventLoopLagMs}ms` : '—'}
          className={metrics ? statusColor(metrics.eventLoopLagMs, 10, 50) : ''}
        />
        <Row
          label="Store events"
          value={metrics ? `${metrics.storeEventsPerSec}/sec` : '—'}
          className={metrics ? statusColor(metrics.storeEventsPerSec, 20, 100) : ''}
        />
        <Row
          label="IPC messages"
          value={metrics ? `${metrics.ipcMessagesPerSec}/sec` : '—'}
          className={metrics ? statusColor(metrics.ipcMessagesPerSec, 30, 150) : ''}
        />
        <Row
          label="Terminal data"
          value={metrics ? formatBytes(metrics.totalTerminalBytesPerSec) : '—'}
          className={
            metrics
              ? statusColor(metrics.totalTerminalBytesPerSec, 100 * 1024, 1024 * 1024)
              : ''
          }
        />
        <Row
          label="Active PTYs"
          value={metrics ? String(metrics.activePtyCount) : '—'}
          className=""
        />
        <Row
          label="Memory (main)"
          value={metrics ? `${metrics.memoryMB.rss} MB` : '—'}
          className={metrics ? statusColor(metrics.memoryMB.rss, 200, 500) : ''}
        />
        <Row
          label="Memory (render)"
          value={`${rendererMemoryMB} MB`}
          className={statusColor(rendererMemoryMB, 200, 500)}
        />
        <Row
          label="Uptime"
          value={metrics ? formatUptime(metrics.uptimeSeconds) : '—'}
          className=""
        />

        {/* Recent events */}
        {recentEvents.length > 0 && (
          <>
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                fontSize: 10,
                color: '#777',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 2,
              }}
            >
              Recent events
            </div>
            <div style={{ maxHeight: 100, overflowY: 'auto' }}>
              {recentEvents.slice(0, 10).map((e) => (
                <div
                  key={e.type}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '1px 0',
                  }}
                >
                  <span style={{ color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
                    {e.type}
                  </span>
                  <span style={{ color: e.count > 10 ? '#f87171' : e.count > 3 ? '#fbbf24' : '#9ca3af', flexShrink: 0 }}>
                    &times;{e.count}
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

function Row({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className: string
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
      <span style={{ color: '#999' }}>{label}</span>
      <span className={className}>{value}</span>
    </div>
  )
}
