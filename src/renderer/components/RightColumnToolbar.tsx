import { useState, useRef, useEffect } from 'react'
import { PanelRightClose, SlidersHorizontal, Check } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { HiddenRightPanels, RightPanelKey } from '../../shared/state/repo-configs'

interface PanelDef {
  key: RightPanelKey
  label: string
}

const PANELS: PanelDef[] = [
  { key: 'merge', label: 'Merge Locally' },
  { key: 'pr', label: 'PR Status' },
  { key: 'commits', label: 'Branch Commits' },
  { key: 'changedFiles', label: 'Changed Files' },
  { key: 'allFiles', label: 'All Files' },
  { key: 'cost', label: 'Cost' }
]

interface RightColumnToolbarProps {
  hidden: HiddenRightPanels
  /** Called when the user toggles a panel. Receives the full next map. */
  onChangeHidden: (next: HiddenRightPanels) => void
  /** Called when the user clicks the collapse button. */
  onCollapse: () => void
  /** Whether per-repo dropdown is actionable (needs an active repo). */
  canConfigure: boolean
}

export function RightColumnToolbar({
  hidden,
  onChangeHidden,
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
    const next: HiddenRightPanels = { ...hidden }
    if (isHidden) delete next[key]
    else next[key] = true
    onChangeHidden(next)
  }

  return (
    <div className="drag-region flex items-center justify-end h-9 shrink-0 border-b border-border bg-panel px-2 gap-1">
      <div className="no-drag relative" ref={menuRef}>
        <Tooltip label="Panel visibility">
          <button
            onClick={() => canConfigure && setMenuOpen((v) => !v)}
            disabled={!canConfigure}
            className="flex items-center justify-center w-7 h-7 rounded text-muted hover:bg-panel-raised/40 hover:text-fg-bright disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            aria-label="Panel visibility"
          >
            <SlidersHorizontal size={14} />
          </button>
        </Tooltip>
        {menuOpen && (
          <div
            className="absolute right-0 top-8 z-50 min-w-[180px] rounded border border-border bg-panel-raised shadow-lg py-1"
            role="menu"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-faint font-medium">
              Panels
            </div>
            {PANELS.map((p) => {
              const visible = !hidden[p.key]
              return (
                <button
                  key={p.key}
                  onClick={() => togglePanel(p.key)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg-bright hover:bg-panel/60 cursor-pointer text-left"
                  role="menuitemcheckbox"
                  aria-checked={visible}
                >
                  <span className="w-3 h-3 flex items-center justify-center shrink-0">
                    {visible && <Check size={12} className="text-accent" />}
                  </span>
                  <span className="flex-1">{p.label}</span>
                </button>
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
          <PanelRightClose size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
