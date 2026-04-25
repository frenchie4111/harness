// Stub browser manager for headless mode.
//
// THIS IS A SEAM. The next worktree replaces this stub with a real
// headless implementation backed by Playwright or chrome-devtools-protocol
// — same external surface, but the views live in spawned Chrome / Firefox
// processes the host can drive over CDP, not a WebContentsView attached
// to an Electron window. Until that lands, every method here either
// returns an "empty" answer (no tabs, no URL, no console output) or
// no-ops with a one-shot warning.
//
// Why keep the surface at all instead of stripping browser code out of
// index.ts: persistence, control-server wiring, and pane reconciliation
// all reference `browserManager.<method>`. Holding the contract steady
// means none of those call sites need to grow runtime-mode branches.

import type { BrowserManagerLike, ConsoleLog } from './browser-manager-types'
import type { Store } from './store'
import { log } from './debug'

const warned = new Set<string>()
function warnOnce(method: string): void {
  if (warned.has(method)) return
  warned.add(method)
  log('browser-headless', `'${method}' called but browser tabs are unavailable in headless mode`)
}

export class HeadlessBrowserManager implements BrowserManagerLike {
  setStore(_store: Store): void {
    // No-op — there are no view events to dispatch.
  }

  hasTab(_tabId: string): boolean {
    return false
  }

  listAllTabIds(): string[] {
    return []
  }

  listTabsForWorktree(_worktreePath: string): string[] {
    return []
  }

  getWorktreePath(_tabId: string): string | null {
    return null
  }

  getConsoleLogs(_tabId: string): ConsoleLog[] {
    return []
  }

  getUrl(_tabId: string): string | null {
    return null
  }

  getTabInfo(_tabId: string): { id: string; url: string; title: string } | null {
    return null
  }

  create(_tabId: string, _worktreePath: string, _url: string): void {
    warnOnce('create')
  }

  destroy(_tabId: string): void {
    // No-op — nothing to destroy.
  }

  destroyAll(): void {
    // No-op.
  }

  destroyAllForWorktree(_worktreePath: string): void {
    // No-op.
  }

  navigate(_tabId: string, _url: string): void {
    warnOnce('navigate')
  }

  back(_tabId: string): void {
    warnOnce('back')
  }

  forward(_tabId: string): void {
    warnOnce('forward')
  }

  reload(_tabId: string): void {
    warnOnce('reload')
  }

  openDevTools(_tabId: string): void {
    warnOnce('openDevTools')
  }

  hide(_tabId: string): void {
    // No-op.
  }

  // setBounds takes a BrowserWindow which only exists in Electron mode.
  // The signature still has to match BrowserManagerLike for typing — at
  // runtime this never fires because the headless transport doesn't
  // register the `browser:setBounds` IPC handler.
  setBounds(_tabId: string, _win: unknown, _bounds: { x: number; y: number; width: number; height: number }): void {
    warnOnce('setBounds')
  }

  clickTab(
    _tabId: string,
    _x: number,
    _y: number,
    _options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): void {
    warnOnce('clickTab')
  }

  typeTab(_tabId: string, _text: string, _key?: string): void {
    warnOnce('typeTab')
  }

  async scrollTab(_tabId: string, _dx: number, _dy: number): Promise<void> {
    warnOnce('scrollTab')
  }

  async showCursor(
    _tabId: string,
    _x: number,
    _y: number,
    _opts?: { pulse?: boolean }
  ): Promise<void> {
    warnOnce('showCursor')
  }

  async getClickables(_tabId: string): Promise<unknown | null> {
    warnOnce('getClickables')
    return null
  }

  async capturePage(
    _tabId: string,
    _opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<{ data: string; format: 'jpeg' | 'png' } | null> {
    warnOnce('capturePage')
    return null
  }

  async getDom(_tabId: string): Promise<string | null> {
    warnOnce('getDom')
    return null
  }
}
