import { useState, useEffect, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

interface RightPanelProps {
  /** Stable id used as the localStorage key for collapse state. */
  id: string
  title: string
  children: ReactNode
  /** Rendered inline next to the title (inside the collapse button). */
  titleExtra?: ReactNode
  /** Rendered on the right side of the header. Clicks don't toggle collapse. */
  actions?: ReactNode
  /** If true, the panel claims remaining vertical space (flex-1). */
  grow?: boolean
  /** Tailwind max-height class applied to the body when !grow (e.g. 'max-h-56'). */
  maxHeight?: string
  defaultCollapsed?: boolean
  headerClassName?: string
  containerClassName?: string
}

const STORAGE_PREFIX = 'right-panel-collapsed:'

export function RightPanel({
  id,
  title,
  children,
  titleExtra,
  actions,
  grow = false,
  maxHeight,
  defaultCollapsed = false,
  headerClassName = '',
  containerClassName = ''
}: RightPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + id)
      if (saved !== null) return saved === '1'
    } catch {
      /* ignore */
    }
    return defaultCollapsed
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [id, collapsed])

  const outerSize = grow && !collapsed ? 'flex-1 min-h-0' : 'shrink-0'
  const bodyClasses = collapsed
    ? ''
    : grow
      ? 'flex-1 min-h-0 flex flex-col'
      : `${maxHeight ?? ''} flex flex-col`

  return (
    <div
      className={`flex flex-col border-b border-border bg-panel ${outerSize} ${containerClassName}`}
    >
      <div
        className={`drag-region flex items-stretch h-9 shrink-0 ${
          collapsed ? '' : 'border-b border-border'
        } ${headerClassName}`}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="no-drag flex-1 flex items-center gap-1.5 px-3 hover:bg-panel-raised/40 cursor-pointer text-left min-w-0"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-faint transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-xs font-medium text-muted uppercase tracking-wide truncate">
            {title}
          </span>
          {titleExtra}
        </button>
        {actions && (
          <div className="no-drag flex items-center gap-2 pr-3">{actions}</div>
        )}
      </div>
      {!collapsed && <div className={bodyClasses}>{children}</div>}
    </div>
  )
}
