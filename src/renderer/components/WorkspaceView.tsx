import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection
} from '@dnd-kit/core'
import type { WorkspacePane, PtyStatus } from '../types'
import { TerminalPanel } from './TerminalPanel'
import { XTerminal } from './XTerminal'
import { DiffView } from './DiffView'
import { FileView } from './FileView'

interface WorkspaceViewProps {
  worktreePath: string
  panes: WorkspacePane[]
  focusedPaneId: string
  statuses: Record<string, PtyStatus>
  visible: boolean
  claudeCommand: string
  repoLabel: string
  branch: string
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onAddTab: (worktreePath: string, paneId?: string) => void
  onAddClaudeTab: (worktreePath: string, paneId?: string) => void
  onCloseTab: (worktreePath: string, tabId: string) => void
  onRestartClaudeTab: (worktreePath: string, tabId: string) => void
  onReorderTabs: (worktreePath: string, paneId: string, fromId: string, toId: string) => void
  onMoveTabToPane: (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => void
  onSplitPane: (worktreePath: string, fromPaneId: string) => void
  onSendToClaude?: (worktreePath: string, text: string) => void
}

// Collision strategy: prefer direct hits (pointerWithin) so dropping over a
// pane container reliably routes to that pane even with empty panes.
const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args)
  if (pointer.length > 0) return pointer
  return closestCenter(args)
}

export function WorkspaceView({
  worktreePath,
  panes,
  focusedPaneId,
  statuses,
  visible,
  claudeCommand,
  onSelectTab,
  onAddTab,
  onAddClaudeTab,
  onCloseTab,
  onRestartClaudeTab,
  onReorderTabs,
  onMoveTabToPane,
  onSplitPane,
  onSendToClaude,
  repoLabel,
  branch
}: WorkspaceViewProps): JSX.Element {
  // Slot elements per pane — TerminalPanel registers its content-area div
  // here so WorkspaceView can portal the right terminals into each slot.
  const [slotEls, setSlotEls] = useState<Record<string, HTMLDivElement | null>>({})

  const registerSlot = useCallback((paneId: string, el: HTMLDivElement | null) => {
    setSlotEls((prev) => (prev[paneId] === el ? prev : { ...prev, [paneId]: el }))
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  // Resolve "where is this tab" and "what pane does this over id refer to".
  const findPaneOfTab = useCallback(
    (tabId: string): WorkspacePane | undefined =>
      panes.find((p) => p.tabs.some((t) => t.id === tabId)),
    [panes]
  )

  // The over id can be either a tab id or a pane id (from the pane drop zone).
  const resolveOverPane = useCallback(
    (overId: string): { pane: WorkspacePane; index: number } | null => {
      const paneDirect = panes.find((p) => p.id === overId)
      if (paneDirect) {
        return { pane: paneDirect, index: paneDirect.tabs.length }
      }
      const pane = findPaneOfTab(overId)
      if (!pane) return null
      const idx = pane.tabs.findIndex((t) => t.id === overId)
      return { pane, index: idx === -1 ? pane.tabs.length : idx }
    },
    [panes, findPaneOfTab]
  )

  const handleDragOver = useCallback(
    (event: DragOverEvent): void => {
      const { active, over } = event
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      if (activeId === overId) return
      const fromPane = findPaneOfTab(activeId)
      const to = resolveOverPane(overId)
      if (!fromPane || !to) return
      // Only handle cross-pane moves here; intra-pane reordering is finalized
      // in handleDragEnd to avoid thrash during the drag.
      if (fromPane.id === to.pane.id) return
      onMoveTabToPane(worktreePath, activeId, to.pane.id, to.index)
    },
    [worktreePath, findPaneOfTab, resolveOverPane, onMoveTabToPane]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      if (activeId === overId) return
      const fromPane = findPaneOfTab(activeId)
      const to = resolveOverPane(overId)
      if (!fromPane || !to) return
      if (fromPane.id === to.pane.id) {
        onReorderTabs(worktreePath, fromPane.id, activeId, overId)
      }
      // Cross-pane moves were already applied in handleDragOver.
    },
    [worktreePath, findPaneOfTab, resolveOverPane, onReorderTabs]
  )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 flex min-w-0 bg-app">
        {panes.map((pane, idx) => (
          <div
            key={pane.id}
            className={`flex-1 flex min-w-0 ${idx > 0 ? 'border-l border-border' : ''}`}
          >
            <TerminalPanel
              worktreePath={worktreePath}
              pane={pane}
              isFocused={pane.id === focusedPaneId}
              paneCount={panes.length}
              statuses={statuses}
              repoLabel={repoLabel}
              branch={branch}
              registerSlot={registerSlot}
              onSelectTab={(tabId) => onSelectTab(worktreePath, pane.id, tabId)}
              onAddTab={() => onAddTab(worktreePath, pane.id)}
              onAddClaudeTab={() => onAddClaudeTab(worktreePath, pane.id)}
              onCloseTab={(tabId) => onCloseTab(worktreePath, tabId)}
              onSplit={() => onSplitPane(worktreePath, pane.id)}
            />
          </div>
        ))}
      </div>

      {/* Portaled terminal/diff content — stable React position keyed by tab.id
         preserves xterm state across pane moves. */}
      {panes.flatMap((pane) =>
        pane.tabs.map((tab) => {
          const slot = slotEls[pane.id]
          if (!slot) return null
          const isActiveInPane = pane.activeTabId === tab.id
          return createPortal(
            <div
              className="absolute inset-0"
              style={{ display: isActiveInPane ? 'block' : 'none' }}
            >
              {tab.type === 'diff' ? (
                <DiffView
                  worktreePath={worktreePath}
                  filePath={tab.filePath}
                  staged={tab.staged ?? false}
                  branchDiff={tab.branchDiff ?? false}
                  commitHash={tab.commitHash}
                  onSendToClaude={
                    onSendToClaude
                      ? (text) => onSendToClaude(worktreePath, text)
                      : undefined
                  }
                />
              ) : tab.type === 'file' ? (
                <FileView
                  worktreePath={worktreePath}
                  filePath={tab.filePath}
                  onSendToClaude={
                    onSendToClaude
                      ? (text) => onSendToClaude(worktreePath, text)
                      : undefined
                  }
                />
              ) : (
                <XTerminal
                  terminalId={tab.id}
                  cwd={worktreePath}
                  type={tab.type as 'claude' | 'shell'}
                  visible={visible && isActiveInPane}
                  claudeCommand={claudeCommand}
                  sessionName={tab.type === 'claude' ? `${repoLabel}/${branch}` : undefined}
                  sessionId={tab.sessionId}
                  initialPrompt={tab.initialPrompt}
                  teleportSessionId={tab.teleportSessionId}
                  onRestartClaude={
                    tab.type === 'claude'
                      ? (): void => onRestartClaudeTab(worktreePath, tab.id)
                      : undefined
                  }
                />
              )}
            </div>,
            slot,
            tab.id
          )
        })
      )}
    </DndContext>
  )
}

