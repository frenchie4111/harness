import { useState, useCallback, useRef } from 'react'
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
import type { PaneNode, PaneLeaf, PaneSplit, PtyStatus, AgentKind } from '../types'
import { getLeaves, findLeafByTabId } from '../../shared/state/terminals'
import { TerminalPanel } from './TerminalPanel'
import { XTerminal } from './XTerminal'
import { DiffView } from './DiffView'
import { FileView } from './FileView'

interface WorkspaceViewProps {
  worktreePath: string
  paneTree: PaneNode
  focusedPaneId: string
  statuses: Record<string, PtyStatus>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  visible: boolean
  nameAgentSessions: boolean
  repoLabel: string
  branch: string
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onAddTab: (worktreePath: string, paneId?: string) => void
  defaultAgent: AgentKind
  onAddAgentTab: (worktreePath: string, agentKind?: AgentKind, paneId?: string) => void
  onCloseTab: (worktreePath: string, tabId: string) => void
  onRestartAgentTab: (worktreePath: string, tabId: string) => void
  onReorderTabs: (worktreePath: string, paneId: string, fromId: string, toId: string) => void
  onMoveTabToPane: (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => void
  onSplitPane: (worktreePath: string, fromPaneId: string, direction?: 'horizontal' | 'vertical') => void
  onSendToAgent?: (worktreePath: string, text: string) => void
  rightColumnHidden: boolean
  onShowRightColumn: () => void
}

const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args)
  if (pointer.length > 0) return pointer
  return closestCenter(args)
}

function PaneDivider({
  direction,
  onResizeEnd
}: {
  direction: 'horizontal' | 'vertical'
  onResizeEnd: (delta: number) => void
}): JSX.Element {
  const lastPos = useRef(0)
  const accum = useRef(0)
  const isHorizontal = direction === 'horizontal'

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    lastPos.current = isHorizontal ? e.clientX : e.clientY
    accum.current = 0

    const onMove = (ev: MouseEvent) => {
      const pos = isHorizontal ? ev.clientX : ev.clientY
      accum.current += pos - lastPos.current
      lastPos.current = pos
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (accum.current !== 0) onResizeEnd(accum.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  if (isHorizontal) {
    return (
      <div className="w-px shrink-0 bg-border relative z-10">
        <div
          onMouseDown={handleMouseDown}
          className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
        />
      </div>
    )
  }
  return (
    <div className="h-px shrink-0 bg-border relative z-10">
      <div
        onMouseDown={handleMouseDown}
        className="absolute inset-x-0 -top-1 -bottom-1 cursor-row-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  )
}

function SplitRenderer({
  node,
  worktreePath,
  focusedPaneId,
  statuses,
  shellActivity,
  repoLabel,
  branch,
  nameAgentSessions,
  leafCount,
  isFirstLeaf,
  lastLeafId,
  showExpandRightColumn,
  onShowRightColumn,
  registerSlot,
  onSelectTab,
  onAddTab,
  defaultAgent,
  onAddAgentTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onResizeEnd
}: {
  node: PaneNode
  worktreePath: string
  focusedPaneId: string
  statuses: Record<string, PtyStatus>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  repoLabel: string
  branch: string
  nameAgentSessions: boolean
  leafCount: number
  isFirstLeaf: { value: boolean }
  lastLeafId: string
  showExpandRightColumn: boolean
  onShowRightColumn: () => void
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void
  onSelectTab: (tabId: string, paneId: string) => void
  onAddTab: (paneId: string) => void
  defaultAgent: AgentKind
  onAddAgentTab: (kind: AgentKind | undefined, paneId: string) => void
  onCloseTab: (tabId: string) => void
  onSplitRight: (paneId: string) => void
  onSplitDown: (paneId: string) => void
  onResizeEnd: (splitId: string, delta: number, containerSize: number) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  if (node.type === 'leaf') {
    const showLabel = isFirstLeaf.value
    if (isFirstLeaf.value) isFirstLeaf.value = false
    return (
      <div className="flex-1 flex min-w-0 min-h-0">
        <TerminalPanel
          worktreePath={worktreePath}
          pane={node}
          isFocused={node.id === focusedPaneId}
          paneCount={leafCount}
          statuses={statuses}
          shellActivity={shellActivity}
          repoLabel={showLabel ? repoLabel : ''}
          branch={showLabel ? branch : ''}
          registerSlot={registerSlot}
          onSelectTab={(tabId) => onSelectTab(tabId, node.id)}
          onAddTab={() => onAddTab(node.id)}
          defaultAgent={defaultAgent}
          onAddAgentTab={(kind) => onAddAgentTab(kind, node.id)}
          onCloseTab={onCloseTab}
          onSplitRight={() => onSplitRight(node.id)}
          onSplitDown={() => onSplitDown(node.id)}
          showExpandRightColumn={showExpandRightColumn && node.id === lastLeafId}
          onShowRightColumn={onShowRightColumn}
        />
      </div>
    )
  }

  const split = node as PaneSplit
  const isHorizontal = split.direction === 'horizontal'
  const firstPercent = `${split.ratio * 100}%`
  const secondPercent = `${(1 - split.ratio) * 100}%`

  return (
    <div
      ref={containerRef}
      className={`flex-1 flex ${isHorizontal ? 'flex-row' : 'flex-col'} min-w-0 min-h-0`}
    >
      <div
        className="flex min-w-0 min-h-0"
        style={{ flexBasis: firstPercent, flexGrow: 0, flexShrink: 0 }}
      >
        <SplitRenderer
          node={split.children[0]}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          statuses={statuses}
          shellActivity={shellActivity}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leafCount}
          isFirstLeaf={isFirstLeaf}
          lastLeafId={lastLeafId}
          showExpandRightColumn={showExpandRightColumn}
          onShowRightColumn={onShowRightColumn}
          registerSlot={registerSlot}
          onSelectTab={onSelectTab}
          onAddTab={onAddTab}
          defaultAgent={defaultAgent}
          onAddAgentTab={onAddAgentTab}
          onCloseTab={onCloseTab}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onResizeEnd={onResizeEnd}
        />
      </div>
      <PaneDivider
        direction={split.direction}
        onResizeEnd={(delta) => {
          const el = containerRef.current
          if (!el) return
          const size = isHorizontal ? el.offsetWidth : el.offsetHeight
          onResizeEnd(split.id, delta, size)
        }}
      />
      <div className="flex flex-1 min-w-0 min-h-0">
        <SplitRenderer
          node={split.children[1]}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          statuses={statuses}
          shellActivity={shellActivity}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leafCount}
          isFirstLeaf={isFirstLeaf}
          lastLeafId={lastLeafId}
          showExpandRightColumn={showExpandRightColumn}
          onShowRightColumn={onShowRightColumn}
          registerSlot={registerSlot}
          onSelectTab={onSelectTab}
          onAddTab={onAddTab}
          defaultAgent={defaultAgent}
          onAddAgentTab={onAddAgentTab}
          onCloseTab={onCloseTab}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onResizeEnd={onResizeEnd}
        />
      </div>
    </div>
  )
}

export function WorkspaceView({
  worktreePath,
  paneTree,
  focusedPaneId,
  statuses,
  shellActivity,
  visible,
  nameAgentSessions,
  onSelectTab,
  onAddTab,
  defaultAgent,
  onAddAgentTab,
  onCloseTab,
  onRestartAgentTab,
  onReorderTabs,
  onMoveTabToPane,
  onSplitPane,
  onSendToAgent,
  repoLabel,
  branch,
  rightColumnHidden,
  onShowRightColumn
}: WorkspaceViewProps): JSX.Element {
  const [slotEls, setSlotEls] = useState<Record<string, HTMLDivElement | null>>({})

  const registerSlot = useCallback((paneId: string, el: HTMLDivElement | null) => {
    setSlotEls((prev) => (prev[paneId] === el ? prev : { ...prev, [paneId]: el }))
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const leaves = getLeaves(paneTree)

  const findPaneOfTab = useCallback(
    (tabId: string): PaneLeaf | undefined => {
      return findLeafByTabId(paneTree, tabId) || undefined
    },
    [paneTree]
  )

  const resolveOverPane = useCallback(
    (overId: string): { pane: PaneLeaf; index: number } | null => {
      const leafDirect = leaves.find((l) => l.id === overId)
      if (leafDirect) {
        return { pane: leafDirect, index: leafDirect.tabs.length }
      }
      const pane = findPaneOfTab(overId)
      if (!pane) return null
      const idx = pane.tabs.findIndex((t) => t.id === overId)
      return { pane, index: idx === -1 ? pane.tabs.length : idx }
    },
    [leaves, findPaneOfTab]
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
    },
    [worktreePath, findPaneOfTab, resolveOverPane, onReorderTabs]
  )

  const handleResizeEnd = useCallback(
    (splitId: string, delta: number, containerSize: number) => {
      if (containerSize === 0) return
      const ratioDelta = delta / containerSize
      void window.api.panesSetRatio(worktreePath, splitId, Math.max(0.1, Math.min(0.9, findSplitRatio(paneTree, splitId) + ratioDelta)))
    },
    [worktreePath, paneTree]
  )

  const isFirstLeaf = { value: true }
  const lastLeafId = leaves[leaves.length - 1]?.id ?? ''

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 flex min-w-0 bg-app">
        <SplitRenderer
          node={paneTree}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          statuses={statuses}
          shellActivity={shellActivity}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leaves.length}
          isFirstLeaf={isFirstLeaf}
          lastLeafId={lastLeafId}
          showExpandRightColumn={rightColumnHidden}
          onShowRightColumn={onShowRightColumn}
          registerSlot={registerSlot}
          onSelectTab={(tabId, paneId) => onSelectTab(worktreePath, paneId, tabId)}
          onAddTab={(paneId) => onAddTab(worktreePath, paneId)}
          defaultAgent={defaultAgent}
          onAddAgentTab={(kind, paneId) => onAddAgentTab(worktreePath, kind, paneId)}
          onCloseTab={(tabId) => onCloseTab(worktreePath, tabId)}
          onSplitRight={(paneId) => onSplitPane(worktreePath, paneId, 'horizontal')}
          onSplitDown={(paneId) => onSplitPane(worktreePath, paneId, 'vertical')}
          onResizeEnd={handleResizeEnd}
        />
      </div>

      {leaves.flatMap((leaf) =>
        leaf.tabs.map((tab) => {
          const slot = slotEls[leaf.id]
          if (!slot) return null
          const isActiveInPane = leaf.activeTabId === tab.id
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
                  onSendToAgent={
                    onSendToAgent
                      ? (text) => onSendToAgent(worktreePath, text)
                      : undefined
                  }
                />
              ) : tab.type === 'file' ? (
                <FileView
                  worktreePath={worktreePath}
                  filePath={tab.filePath}
                  onSendToAgent={
                    onSendToAgent
                      ? (text) => onSendToAgent(worktreePath, text)
                      : undefined
                  }
                />
              ) : (
                <XTerminal
                  terminalId={tab.id}
                  cwd={worktreePath}
                  type={tab.type as 'agent' | 'shell'}
                  agentKind={tab.agentKind}
                  visible={visible && isActiveInPane}
                  sessionName={tab.type === 'agent' && nameAgentSessions ? `${repoLabel}/${branch}` : undefined}
                  sessionId={tab.sessionId}
                  initialPrompt={tab.initialPrompt}
                  teleportSessionId={tab.teleportSessionId}
                  onRestartAgent={
                    tab.type === 'agent'
                      ? (): void => onRestartAgentTab(worktreePath, tab.id)
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

function findSplitRatio(node: PaneNode, splitId: string): number {
  if (node.type === 'leaf') return 0.5
  if (node.id === splitId) return node.ratio
  const found = findSplitRatioInner(node.children[0], splitId)
  if (found !== null) return found
  return findSplitRatioInner(node.children[1], splitId) ?? 0.5
}

function findSplitRatioInner(node: PaneNode, splitId: string): number | null {
  if (node.type === 'leaf') return null
  if (node.id === splitId) return node.ratio
  return (
    findSplitRatioInner(node.children[0], splitId) ??
    findSplitRatioInner(node.children[1], splitId)
  )
}
