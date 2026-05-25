import { useState, useRef, useEffect } from 'react'
import { PanelRightClose, SlidersHorizontal, Check, ChevronUp, ChevronDown } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { HiddenRightPanels, RightPanelKey } from '../../shared/state/repo-configs'

const LABELS: Record<RightPanelKey, string> = {
  merge: 'Merge Locally',
  pr: 'PR Status',
  todos: 'Todos',
  commits: 'Branch Commits',
  changedFiles: 'Changed Files',
  allFiles: 'All Files',
  cost: 'Cost',
  scratchpad: 'Scratchpad'
}

interface RightColumnToolbarProps {
  hidden: HiddenRightPanels
  order: RightPanelKey[]
  /** Called when the user toggles a panel. Receives the full next map. */
  onChangeHidden: (next: HiddenRightPanels) => void
  /** Called when the user reorders panels. Receives the full next order. */
  onChangeOrder: (next: RightPanelKey[]) => void
  /** Called when the user clicks the collapse button. */
  onCollapse: () => void
  /** Whether per-repo dropdown is actionable (needs an active repo). */
  canConfigure: boolean
}

export function RightColumnToolbar({
  hidden,
  order,
  onChangeHidden,
  onChangeOrder,
  onCollapse,
  canConfigure
}: RightColumnToolbarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const togglePanel = (key: RightPanelKey): void => {
    const isHidden = !!hidden[key]
    // Always write explicit boolean (not delete) so the user's choice
    // wins over any DEFAULT_HIDDEN_RIGHT_PANELS entry on next read.
    const next: HiddenRightPanels = { ...hidden, [key]: !isHidden }
    onChangeHidden(next)
  }

  const movePanel = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= order.length) return
    const next = [...order]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChangeOrder(next)
  }

  return (
    <div className="drag-region flex items-center justify-end h-10 shrink-0 border-b border-border bg-panel px-2 gap-1">
      <div className="no-drag relative" ref={menuRef}>
        <Tooltip label="Panel visibility">
          <button
            onClick={() => canConfigure && setMenuOpen((v) => !v)}
            disabled={!canConfigure}
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:bg-panel-raised/40 hover:text-fg-bright disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            aria-label="Panel visibility"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        {menuOpen && (
          <div
            className="absolute right-0 top-9 z-50 min-w-[220px] rounded border border-border bg-panel-raised shadow-lg py-1"
            role="menu"
          >
            <div className="px-3 py-1.5 text-xs uppercase tracking-wide text-faint font-medium">
              Panels
            </div>
            {order.map((key, index) => {
              const visible = !hidden[key]
              const isFirst = index === 0
              const isLast = index === order.length - 1
              return (
                <div
                  key={key}
                  className="flex items-center gap-1 px-2 py-1 hover:bg-panel/60"
                >
                  <button
                    onClick={() => togglePanel(key)}
                    className="flex-1 flex items-center gap-2 px-1 py-0.5 text-xs text-fg-bright cursor-pointer text-left rounded"
                    role="menuitemcheckbox"
                    aria-checked={visible}
                  >
                    <span className="w-3 h-3 flex items-center justify-center shrink-0">
                      {visible && <Check className="w-3 h-3 text-accent" />}
                    </span>
                    <span className="flex-1">{LABELS[key]}</span>
                  </button>
                  <button
                    onClick={() => movePanel(index, -1)}
                    disabled={isFirst}
                    className="flex items-center justify-center w-5 h-5 rounded text-muted hover:bg-panel/80 hover:text-fg-bright disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    aria-label={`Move ${LABELS[key]} up`}
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => movePanel(index, 1)}
                    disabled={isLast}
                    className="flex items-center justify-center w-5 h-5 rounded text-muted hover:bg-panel/80 hover:text-fg-bright disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    aria-label={`Move ${LABELS[key]} down`}
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <Tooltip label="Hide right column" action="toggleRightColumn">
        <button
          onClick={onCollapse}
          className="no-drag flex items-center justify-center w-7 h-7 rounded text-muted hover:bg-panel-raised/40 hover:text-fg-bright cursor-pointer"
          aria-label="Hide right column"
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  )
}
