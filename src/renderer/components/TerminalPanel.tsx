import { useEffect, useRef, useCallback, useState } from 'react'
import { X, SquareTerminal, Sparkles, Code2, SplitSquareHorizontal, SplitSquareVertical, Loader2, PanelRightOpen, Globe, Users } from 'lucide-react'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { WorkspacePane, TerminalTab, PtyStatus, AgentKind } from '../types'
import { AGENT_REGISTRY, agentDisplayName } from '../../shared/agent-registry'
import { Tooltip } from './Tooltip'
import { repoNameColor } from './RepoIcon'
import { getClientId, useTerminalSession } from '../store'

/** Chip shown in the tab bar when other clients are attached to the
 *  active terminal. Click-through is intentional — taking/releasing
 *  control lives on the terminal body, not here. */
function SpectatorChip({ terminalId }: { terminalId: string }): JSX.Element | null {
  const session = useTerminalSession(terminalId)
  if (!session) return null
  const myId = getClientId()
  // Other viewers: everyone who isn't me, counted across controller + spectators.
  const others = new Set<string>()
  if (session.controllerClientId && session.controllerClientId !== myId) {
    others.add(session.controllerClientId)
  }
  for (const id of session.spectatorClientIds) {
    if (id !== myId) others.add(id)
  }
  if (others.size === 0) return null
  const controllerLabel =
    session.controllerClientId === null
      ? 'No controller'
      : session.controllerClientId === myId
        ? 'You have control'
        : `Controller: ${shortId(session.controllerClientId)}`
  const spectatorLines = session.spectatorClientIds
    .filter((id) => id !== myId)
    .map((id) => `Spectator: ${shortId(id)}`)
  const tip = [controllerLabel, ...spectatorLines].join('\n')
  return (
    <Tooltip label={tip}>
      <div className="no-drag shrink-0 flex items-center gap-1 px-2 h-full text-xs text-dim">
        <Users size={12} />
        <span>{others.size}</span>
      </div>
    </Tooltip>
  )
}

function shortId(id: string): string {
  return id.slice(0, 6)
}

interface TerminalPanelProps {
  worktreePath: string
  pane: WorkspacePane
  isFocused: boolean
  paneCount: number
  statuses: Record<string, PtyStatus>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  repoLabel: string
  branch: string
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void
  onSelectTab: (tabId: string) => void
  onAddTab: () => void
  onAddAgentTab: (agentKind?: AgentKind) => void
  onAddBrowserTab: () => void
  /** Optional: when defined, alt-clicking the Sparkles button opens a
   *  json-claude tab (experimental, gated by settings.jsonModeClaudeTabs). */
  onAddJsonClaudeTab?: () => void
  /** Optional: convert a tab between xterm Claude and JSON-mode Claude
   *  in place. Only relevant when the json-mode feature flag is on; the
   *  parent omits it otherwise so the per-tab right-click menu hides. */
  onConvertTabType?: (tabId: string, newType: 'agent' | 'json-claude') => void
  defaultAgent: AgentKind
  onCloseTab: (tabId: string) => void
  onSplitRight: () => void
  onSplitDown: () => void
  showExpandRightColumn: boolean
  onShowRightColumn: () => void
}

const TAB_STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

interface SortableTabProps {
  tab: TerminalTab
  isActive: boolean
  status: PtyStatus
  shellActivity?: { active: boolean; processName?: string }
  showClose: boolean
  onSelect: () => void
  onClose: () => void
  /** Optional: when provided, right-clicking the tab opens a small menu
   *  to convert between xterm Claude and JSON-mode Claude. Only passed
   *  in when the source tab is convertible (Claude agent or json-claude)
   *  and the JSON-mode feature flag is on. */
  onConvertTabType?: (newType: 'agent' | 'json-claude') => void
}

function SortableTab({ tab, isActive, status, shellActivity, showClose, onSelect, onClose, onConvertTabType }: SortableTabProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })
  const localRef = useRef<HTMLDivElement | null>(null)
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el
      setNodeRef(el)
    },
    [setNodeRef]
  )
  useEffect(() => {
    if (isActive && localRef.current) {
      localRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [isActive])
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      className={`no-drag shrink-0 flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 whitespace-nowrap transition-colors ${
        isActive
          ? 'border-muted text-fg-bright'
          : 'border-transparent text-dim hover:text-fg'
      }`}
      onClick={onSelect}
      onContextMenu={
        onConvertTabType
          ? (e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY })
            }
          : undefined
      }
    >
      {tab.type === 'shell' ? (
        shellActivity?.active ? (
          <Loader2
            size={10}
            className="animate-spin text-fg-bright"
            aria-label={`Running: ${shellActivity.processName || '?'}`}
          />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-faint" />
        )
      ) : tab.type !== 'diff' && tab.type !== 'file' ? (
        <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_DOT[status]}`} />
      ) : null}
      <span>{tab.label}</span>
      {showClose && (
        <Tooltip label="Close tab" action="closeTab">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="ml-1 text-faint hover:text-fg transition-colors"
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
      {menu && onConvertTabType && (
        <div
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {tab.type === 'agent' ? (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('json-claude')
              }}
            >
              Convert to JSON-mode chat
            </button>
          ) : (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('agent')
              }}
            >
              Convert to terminal mode
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function TerminalPanel({
  worktreePath,
  pane,
  paneCount,
  statuses,
  shellActivity,
  repoLabel,
  branch,
  registerSlot,
  onSelectTab,
  onAddTab,
  onAddAgentTab,
  onAddBrowserTab,
  onAddJsonClaudeTab,
  onConvertTabType,
  defaultAgent,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  showExpandRightColumn,
  onShowRightColumn
}: TerminalPanelProps): JSX.Element {
  // Droppable target for the pane itself — lets users drop a tab onto an
  // empty pane or past the last tab.
  const { setNodeRef: setPaneDropRef } = useDroppable({ id: pane.id })
  const slotHostRef = useRef<HTMLDivElement | null>(null)

  // Register this pane's slot host with WorkspaceView. WorkspaceView owns a
  // stable slot DOM element per pane.id and appends it into whichever host
  // currently exists, so a split (which unmounts + remounts this panel at a
  // deeper tree position) does not destroy the xterm portal's target.
  useEffect(() => {
    registerSlot(pane.id, slotHostRef.current)
  }, [pane.id, registerSlot])

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  // Spectator chip only makes sense for xterm-backed tabs. JSON-mode
  // agent tabs (when they land) re-render per client, so the controller/
  // spectator concept doesn't apply.
  const showSpectatorChip =
    !!activeTab && (activeTab.type === 'agent' || activeTab.type === 'shell')

  return (
    <div ref={setPaneDropRef} className="flex-1 flex flex-col min-w-0 bg-app">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b border-border bg-panel h-10 shrink-0">
        {repoLabel && (
          <div
            className="no-drag shrink-0 flex items-baseline gap-1.5 px-3 h-full text-xs whitespace-nowrap"
            title={`${repoLabel} / ${branch}`}
            style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}
          >
            <span className={`font-medium ${repoNameColor(repoLabel)}`}>{repoLabel}</span>
            <span className="text-faint">/</span>
            <span className="text-fg-bright font-medium">{branch}</span>
          </div>
        )}
        <div className="flex items-center h-full overflow-x-auto scrollbar-hidden pl-2 flex-1 min-w-0">
          <SortableContext items={pane.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {pane.tabs.map((tab) => {
              const isClaudeAgent = tab.type === 'agent' && tab.agentKind === 'claude'
              const isJsonClaude = tab.type === 'json-claude'
              const convertible = !!onConvertTabType && (isClaudeAgent || isJsonClaude)
              return (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === pane.activeTabId}
                  status={statuses[tab.id] || 'idle'}
                  shellActivity={shellActivity[tab.id]}
                  showClose={pane.tabs.length > 1 || paneCount > 1}
                  onSelect={() => onSelectTab(tab.id)}
                  onClose={() => onCloseTab(tab.id)}
                  onConvertTabType={
                    convertible
                      ? (newType) => onConvertTabType!(tab.id, newType)
                      : undefined
                  }
                />
              )
            })}
          </SortableContext>
          <Tooltip
            label={
              `New ${agentDisplayName(defaultAgent)} tab` +
              (AGENT_REGISTRY.length > 1
                ? ` · ⌥-click for ${agentDisplayName(AGENT_REGISTRY.find((a) => a.kind !== defaultAgent)?.kind)}`
                : '') +
              (onAddJsonClaudeTab ? ' · ⇧-click for Claude (JSON, experimental)' : '')
            }
          >
            <button
              onClick={(e) => {
                // Modifier precedence: shift opens the experimental
                // json-claude tab (when its feature flag is on); alt
                // opens the *other* registered agent (Codex when default
                // is Claude, vice versa). Plain click opens the default.
                if (e.shiftKey && onAddJsonClaudeTab) {
                  onAddJsonClaudeTab()
                } else if (e.altKey && AGENT_REGISTRY.length > 1) {
                  const other = AGENT_REGISTRY.find((a) => a.kind !== defaultAgent)
                  onAddAgentTab(other?.kind)
                } else {
                  onAddAgentTab(defaultAgent)
                }
              }}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Sparkles size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New shell tab" action="newShellTab">
            <button
              onClick={onAddTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <SquareTerminal size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New browser tab">
            <button
              onClick={onAddBrowserTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Globe size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Split pane right" action="splitPaneRight">
            <button
              onClick={onSplitRight}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <SplitSquareHorizontal size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Split pane down" action="splitPaneDown">
            <button
              onClick={onSplitDown}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <SplitSquareVertical size={12} />
            </button>
          </Tooltip>
          {showSpectatorChip && activeTab && <SpectatorChip terminalId={activeTab.id} />}
        </div>
        <Tooltip label="Open worktree in editor" action="openInEditor" side="left">
          <button
            onClick={() => window.api.openInEditor(worktreePath)}
            className="no-drag shrink-0 px-3 h-full text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <Code2 size={13} />
          </button>
        </Tooltip>
        {showExpandRightColumn && (
          <Tooltip label="Show right column" action="toggleRightColumn" side="left">
            <button
              onClick={onShowRightColumn}
              className="no-drag shrink-0 pr-3 h-full text-faint hover:text-fg transition-colors cursor-pointer"
            >
              <PanelRightOpen size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Content slot host — WorkspaceView imperatively appends a stable
          slot div (the portal target for xterm/diff content) into this host.
          The host is empty from React's perspective; see slotHostRef. */}
      <div ref={slotHostRef} className="flex-1 relative min-h-0" />
    </div>
  )
}
