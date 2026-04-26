// Mirrors json-claude session state into terminals/statusChanged so the
// sidebar + tab-bar dots light up the same way they do for xterm-backed
// agent tabs. We can't piggyback on the user-scope status hooks (we
// scrub HARNESS_TERMINAL_ID from the json-claude subprocess env so they
// don't fire), so derive the status here from busy + pendingApprovals +
// session.state on every jsonClaude/* event.
//
// Mapping:
//   exited            → terminals/removed
//   pending approval  → needs-approval (with PendingTool)
//   busy              → processing
//   otherwise         → waiting
//
// Same dot semantics as xterm tabs, no UI changes needed downstream.

import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PtyStatus, PendingTool } from '../shared/state/terminals'

export class JsonClaudeStatusDeriver {
  private store: Store
  private unsubscribe: (() => void) | null = null

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  private onEvent(event: StateEvent): void {
    if (!event.type.startsWith('jsonClaude/')) return
    const jc = this.store.getSnapshot().state.jsonClaude
    // Re-derive every json-claude session's status. There are usually
    // only a handful, so the linear walk is cheap; scoping to a single
    // session would require threading sessionId through every event
    // payload (approvalResolved doesn't carry it).
    for (const sessionId of Object.keys(jc.sessions)) {
      const session = jc.sessions[sessionId]
      if (!session) continue
      if (session.state === 'exited') {
        this.store.dispatch({ type: 'terminals/removed', payload: sessionId })
        continue
      }
      let status: PtyStatus
      let pendingTool: PendingTool | null = null
      const approval = Object.values(jc.pendingApprovals).find(
        (a) => a.sessionId === sessionId
      )
      if (approval) {
        status = 'needs-approval'
        pendingTool = { name: approval.toolName, input: approval.input }
      } else if (session.busy) {
        status = 'processing'
      } else {
        status = 'waiting'
      }
      this.store.dispatch({
        type: 'terminals/statusChanged',
        payload: { id: sessionId, status, pendingTool }
      })
    }
  }
}
