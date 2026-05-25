import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { MAX_WAKE } from '../../shared/state/snooze'

interface SnoozeCalendarProps {
  /** Anchor element rect (top/left/width/height in client coords) used to
   *  position the popover. */
  anchor: { top: number; left: number; width: number; height: number }
  defaultDays: number
  onPick: (wakeAtMs: number) => void
  onDismiss: () => void
}

const DAY_MS = 86400000
const MAX_MONTHS_AHEAD = 12

function startOfDay(d: Date): Date {
  const next = new Date(d)
  next.setHours(0, 0, 0, 0)
  return next
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
}

function buildMonthGrid(viewMonth: Date): Date[] {
  const first = startOfMonth(viewMonth)
  const startDow = first.getDay() // 0 = Sunday
  const cells: Date[] = []
  const firstCell = addDays(first, -startDow)
  for (let i = 0; i < 42; i++) {
    cells.push(addDays(firstCell, i))
  }
  return cells
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function SnoozeCalendar({
  anchor,
  defaultDays,
  onPick,
  onDismiss
}: SnoozeCalendarProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const today = useMemo(() => startOfDay(new Date()), [])
  const tomorrow = useMemo(() => addDays(today, 1), [today])
  const maxMonth = useMemo(() => addMonths(startOfMonth(today), MAX_MONTHS_AHEAD), [today])
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(today))

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      if (!popoverRef.current) return
      if (popoverRef.current.contains(e.target as Node)) return
      onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  const cells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth])
  const canGoPrev = monthDiff(startOfMonth(today), viewMonth) > 0
  const canGoNext = monthDiff(startOfMonth(today), viewMonth) < MAX_MONTHS_AHEAD

  const pickDate = (d: Date): void => {
    if (d.getTime() < tomorrow.getTime()) return
    onPick(d.getTime())
  }

  const presets: Array<{ label: string; days: number; highlight?: boolean }> = [
    { label: 'Tomorrow', days: 1 },
    { label: '1 week', days: 7, highlight: defaultDays === 7 },
    { label: '1 month', days: 30 }
  ]

  // Position to the right of the trigger when there's room; otherwise to the left.
  const POPOVER_W = 248
  const GAP = 6
  const left = (() => {
    const preferred = anchor.left + anchor.width + GAP
    if (preferred + POPOVER_W <= window.innerWidth - 8) return preferred
    return Math.max(8, anchor.left - POPOVER_W - GAP)
  })()
  const top = Math.min(
    Math.max(8, anchor.top),
    Math.max(8, window.innerHeight - 280)
  )

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 bg-panel border border-border-strong rounded shadow-lg p-2"
      style={{ top, left, width: POPOVER_W }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-1.5">
        <button
          onClick={() => canGoPrev && setViewMonth((m) => addMonths(m, -1))}
          disabled={!canGoPrev}
          className="text-faint hover:text-fg disabled:opacity-40 cursor-pointer disabled:cursor-default p-0.5"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <div className="text-xs font-semibold text-fg">
          {viewMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
        </div>
        <button
          onClick={() => canGoNext && setViewMonth((m) => addMonths(m, 1))}
          disabled={!canGoNext}
          className="text-faint hover:text-fg disabled:opacity-40 cursor-pointer disabled:cursor-default p-0.5"
          aria-label="Next month"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-faint mb-1">
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d) => {
          const inMonth = d.getMonth() === viewMonth.getMonth()
          const disabled = d.getTime() < tomorrow.getTime() || d.getTime() > addMonths(maxMonth, 1).getTime()
          const isToday = d.getTime() === today.getTime()
          return (
            <button
              key={d.toISOString()}
              onClick={() => pickDate(d)}
              disabled={disabled}
              className={`text-xs rounded px-1 py-1 transition-colors cursor-pointer disabled:cursor-default ${
                disabled
                  ? 'text-faint/40'
                  : inMonth
                    ? 'text-fg hover:bg-panel-raised'
                    : 'text-dim hover:bg-panel-raised'
              } ${isToday ? 'ring-1 ring-accent/50' : ''}`}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border-strong">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => onPick(Date.now() + p.days * DAY_MS)}
            className={`flex-1 text-xs rounded px-1.5 py-1 transition-colors cursor-pointer ${
              p.highlight
                ? 'bg-accent text-app font-semibold hover:opacity-90'
                : 'text-dim hover:text-fg hover:bg-panel-raised'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => onPick(MAX_WAKE)}
          className="flex-1 text-xs rounded px-1.5 py-1 text-dim hover:text-fg hover:bg-panel-raised transition-colors cursor-pointer"
        >
          Never
        </button>
      </div>
    </div>
  )
}
