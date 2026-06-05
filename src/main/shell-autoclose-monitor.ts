import type { Store } from './store'
import type { PanesFSM } from './panes-fsm'
import type { PtyManager } from './pty-manager'
import { findLeafByTabId } from '../shared/state/terminals'
import { log } from './debug'

/** Watches shell PTY exits and auto-closes the tab a configurable delay
 *  after a *successful* run (exit code 0), honoring the tab's `closeDelay`.
 *
 *  Rules (see the create_shell MCP tool):
 *   - Only shell tabs with `closeDelay` set are eligible.
 *   - A non-zero exit code (failure) never auto-closes — the user keeps the
 *     error output.
 *   - At fire time we re-read state: the tab must still exist, still carry a
 *     `closeDelay` (cleared via "Keep open"), and must NOT be its leaf's
 *     active tab — a tab the user is looking at stays open.
 *
 *  The exit code isn't in the store's terminals/removed event, so we hook
 *  PtyManager.addExitListener directly rather than subscribing to the store. */
export class ShellAutoCloseMonitor {
  private store: Store
  private panesFSM: PanesFSM
  private timers = new Map<string, NodeJS.Timeout>()
  private unsubscribe: (() => void) | null = null

  constructor(store: Store, panesFSM: PanesFSM, ptyManager: PtyManager) {
    this.store = store
    this.panesFSM = panesFSM
    this.unsubscribe = ptyManager.addExitListener((id, exitCode) =>
      this.onExit(id, exitCode)
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private onExit(id: string, exitCode: number): void {
    if (exitCode !== 0) return
    const located = this.locate(id)
    if (!located) return
    const { tab } = located
    if (tab.type !== 'shell' || tab.closeDelay === undefined) return

    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.fire(id)
    }, tab.closeDelay * 1000)
    this.timers.set(id, timer)
  }

  private fire(id: string): void {
    const located = this.locate(id)
    if (!located) return
    const { wtPath, tab, activeTabId } = located
    // "Keep open" cleared closeDelay, or the user is now viewing the tab.
    if (tab.closeDelay === undefined) return
    if (activeTabId === id) return
    log('shell-autoclose', `close tab=${id} wt=${wtPath} delay=${tab.closeDelay}s`)
    this.panesFSM.closeTab(wtPath, id)
  }

  /** Resolve a shell tab id to its worktree path, tab record, and the
   *  active-tab id of the leaf that holds it. Null if no longer present. */
  private locate(
    id: string
  ): { wtPath: string; tab: import('../shared/state/terminals').TerminalTab; activeTabId: string } | null {
    const panes = this.store.getSnapshot().state.terminals.panes
    for (const [wtPath, tree] of Object.entries(panes)) {
      const leaf = findLeafByTabId(tree, id)
      const tab = leaf?.tabs.find((t) => t.id === id)
      if (leaf && tab) return { wtPath, tab, activeTabId: leaf.activeTabId }
    }
    return null
  }
}
