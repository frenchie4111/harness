import { useEffect, useState } from 'react'
import type { SessionUsage } from '../types'

interface Props {
  cwd: string
  sessionId: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function formatCost(c: number): string {
  if (c >= 100) return `$${c.toFixed(0)}`
  if (c >= 10) return `$${c.toFixed(1)}`
  return `$${c.toFixed(2)}`
}

export function UsageBadge({ cwd, sessionId }: Props): JSX.Element | null {
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const next = await window.api.getSessionUsage(cwd, sessionId)
      if (cancelled) return
      if (next) {
        setUsage(next)
        setMissing(false)
      } else {
        setMissing(true)
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cwd, sessionId])

  if (missing && !usage) return null

  const totalIn =
    (usage?.inputTokens || 0) +
    (usage?.cacheReadTokens || 0) +
    (usage?.cacheWriteTokens || 0)
  const totalOut = usage?.outputTokens || 0
  const cost = usage?.estimatedCost || 0

  return (
    <div
      className="absolute top-1 right-2 px-2 py-0.5 text-[10px] leading-none rounded bg-panel/80 text-dim font-mono pointer-events-none select-none border border-border/50"
      title={
        usage
          ? `Input: ${usage.inputTokens.toLocaleString()}\n` +
            `Output: ${usage.outputTokens.toLocaleString()}\n` +
            `Cache read: ${usage.cacheReadTokens.toLocaleString()}\n` +
            `Cache write: ${usage.cacheWriteTokens.toLocaleString()}\n` +
            `Estimated cost: $${cost.toFixed(4)}`
          : 'No usage yet'
      }
    >
      {formatTokens(totalIn)} in · {formatTokens(totalOut)} out · {formatCost(cost)}
    </div>
  )
}
