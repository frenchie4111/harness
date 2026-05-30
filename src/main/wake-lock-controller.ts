import { powerSaveBlocker } from 'electron'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import { log } from './debug'

/** How often the controller re-checks time-driven + drift-prone inputs: the
 *  temporary-timer expiry, plus a cheap reconcile of the processing-id set
 *  against authoritative status (self-heal — see reconcileProcessing). Agent-
 *  status and setting changes are handled synchronously via store events;
 *  this tick only catches the passage of wall-clock time and any drift. */
const TICK_MS = 30_000

/** Holds a single power-save blocker while a wake-lock is wanted.
 *
 *  The decision is `(mode wants it) OR (the temporary timer is live)`:
 *  - mode 'off'                 → never
 *  - mode 'always'              → always
 *  - mode 'while-agents-running'→ any terminal status === 'processing'
 *  - timer overlay              → now < settings.preventSleepUntil
 *
 *  We use `prevent-app-suspension` (CPU stays awake, the display may still
 *  sleep) — for unattended agent runs we want compute alive, not the
 *  screen on. No entitlements / notarization impact.
 *
 *  This is a pure side-effect reactor: it subscribes to the store and
 *  NEVER dispatches except to clear an expired `preventSleepUntil` back to
 *  null (a low-frequency, once-per-expiry event). The set of processing
 *  terminal ids is maintained incrementally from the event payloads so the
 *  hot path (status events firing many times per second) stays O(1) — no
 *  sweep over all terminals, no per-token dispatch. The 30s tick reconciles
 *  that set against authoritative status so a missed event can't leave the
 *  lock stuck on. */
export class WakeLockController {
  private store: Store
  private unsubscribe: (() => void) | null = null
  private tick: NodeJS.Timeout | null = null
  /** Terminal ids currently in 'processing'. Maintained incrementally on the
   *  hot path; rebuilt from authoritative status on each tick + at start. */
  private processingIds = new Set<string>()
  /** Cached desired state — the wake-lock is only (re)started/stopped on a
   *  transition, never re-applied on an unchanged tick. */
  private held = false
  /** The single active blocker id, or null when nothing is held. */
  private blockerId: number | null = null

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
    // Seed from current status — a terminal may already be 'processing'
    // before we subscribed (or persisted mode is already 'always').
    this.reconcileProcessing()
    this.tick = setInterval(() => this.onTick(), TICK_MS)
    this.evaluate()
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = null
    }
    this.releaseBlocker()
    this.held = false
    this.processingIds.clear()
  }

  private onEvent(event: StateEvent): void {
    // Keep the processing-id set current. Only statusChanged / removed
    // touch it; do this before the early-out so the set never drifts.
    if (event.type === 'terminals/statusChanged') {
      const { id, status } = event.payload
      if (status === 'processing') this.processingIds.add(id)
      else this.processingIds.delete(id)
    } else if (event.type === 'terminals/removed') {
      this.processingIds.delete(event.payload)
    } else if (
      event.type !== 'settings/preventSleepModeChanged' &&
      event.type !== 'settings/preventSleepUntilChanged'
    ) {
      // No other event can change the wake-lock decision — skip the work.
      return
    }
    this.evaluate()
  }

  /** Periodic self-heal: catch temporary-timer expiry and rebuild the
   *  processing-set from authoritative status, so a missed statusChanged /
   *  removed (or a terminal whose status entry vanished another way) can't
   *  leave the lock engaged forever. O(N) but only every TICK_MS. */
  private onTick(): void {
    this.reconcileProcessing()
    this.evaluate()
  }

  private reconcileProcessing(): void {
    const statuses = this.store.getSnapshot().state.terminals.statuses
    this.processingIds.clear()
    for (const id in statuses) {
      if (statuses[id] === 'processing') this.processingIds.add(id)
    }
  }

  private evaluate(): void {
    const settings = this.store.getSnapshot().state.settings
    const nowMs = Date.now()

    // Expire the temporary timer first. Clearing it dispatches a single
    // event which re-enters evaluate() with until === null, so return and
    // let that pass do the actual start/stop.
    if (settings.preventSleepUntil !== null && nowMs >= settings.preventSleepUntil) {
      this.store.dispatch({ type: 'settings/preventSleepUntilChanged', payload: null })
      return
    }

    const desired = this.computeDesired(settings.preventSleepUntil, nowMs, settings.preventSleepMode)
    if (desired === this.held) return
    this.held = desired
    if (desired) {
      this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
      log('wake-lock', `engaged (mode=${settings.preventSleepMode}, id=${this.blockerId})`)
    } else {
      this.releaseBlocker()
      log('wake-lock', `released (mode=${settings.preventSleepMode})`)
    }
  }

  private computeDesired(until: number | null, nowMs: number, mode: string): boolean {
    if (until !== null && nowMs < until) return true
    switch (mode) {
      case 'always':
        return true
      case 'while-agents-running':
        return this.processingIds.size > 0
      case 'off':
      default:
        return false
    }
  }

  private releaseBlocker(): void {
    if (this.blockerId === null) return
    if (powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId)
    }
    this.blockerId = null
  }
}
