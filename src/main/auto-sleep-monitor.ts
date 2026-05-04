import type { Store } from './store'
import type { PanesFSM } from './panes-fsm'
import { getLeaves } from '../shared/state/terminals'
import { log } from './debug'

const SWEEP_INTERVAL_MS = 60_000

/** Sweeps the panes tree once a minute and sleeps json-mode tabs that
 *  have been sitting at the yellow 'waiting' dot longer than the
 *  configured threshold. A periodic timer is used (not a store
 *  subscription) so streaming events don't fan-out a sweep per token —
 *  see CLAUDE.md anti-pattern #1. */
export class AutoSleepMonitor {
  private store: Store
  private panesFSM: PanesFSM
  private timer: NodeJS.Timeout | null = null

  constructor(store: Store, panesFSM: PanesFSM) {
    this.store = store
    this.panesFSM = panesFSM
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private sweep(): void {
    const state = this.store.getSnapshot().state
    const minutes = state.settings.autoSleepMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    const thresholdMs = minutes * 60_000
    const now = Date.now()
    for (const [wtPath, tree] of Object.entries(state.terminals.panes)) {
      const lastActive = state.terminals.lastActive[wtPath]
      if (typeof lastActive !== 'number') continue
      if (now - lastActive <= thresholdMs) continue
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type !== 'json-claude') continue
          if ((tab.mode ?? 'awake') !== 'awake') continue
          if (state.terminals.statuses[tab.id] !== 'waiting') continue
          // Skip the spawn-race window: a connecting session has fired
          // sessionStarted but not yet reached running, and killing it
          // mid-spawn would race the JsonClaudeManager's create().
          const session = state.jsonClaude.sessions[tab.id]
          if (session?.state === 'connecting') continue
          log(
            'auto-sleep',
            `sleep tab=${tab.id} wt=${wtPath} idleMs=${now - lastActive}`
          )
          this.panesFSM.sleepJsonClaudeTab(wtPath, tab.id)
        }
      }
    }
  }
}
