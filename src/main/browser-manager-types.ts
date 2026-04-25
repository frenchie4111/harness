// Browser manager contract shared between the Electron-backed BrowserManager
// (uses WebContentsView under the hood) and the headless stub. Holding the
// interface in its own file keeps both implementations honest at compile
// time and lets index.ts depend only on the contract — never on the
// concrete class — so the static `import 'electron'` chain stops here.
//
// `setBounds` takes an `unknown` window param in this interface so the
// shared type doesn't transitively pull `@types/electron`'s BrowserWindow
// into modules that don't otherwise need it. The Electron implementation
// narrows it back to `BrowserWindow` at the implementation site.

import type { Store } from './store'

export interface ConsoleLog {
  ts: number
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  message: string
}

export interface BrowserManagerLike {
  setStore(store: Store): void
  hasTab(tabId: string): boolean
  listAllTabIds(): string[]
  listTabsForWorktree(worktreePath: string): string[]
  getWorktreePath(tabId: string): string | null
  getConsoleLogs(tabId: string): ConsoleLog[]
  getUrl(tabId: string): string | null
  getTabInfo(tabId: string): { id: string; url: string; title: string } | null
  create(tabId: string, worktreePath: string, url: string): void
  destroy(tabId: string): void
  destroyAll(): void
  destroyAllForWorktree(worktreePath: string): void
  navigate(tabId: string, url: string): void
  back(tabId: string): void
  forward(tabId: string): void
  reload(tabId: string): void
  openDevTools(tabId: string): void
  hide(tabId: string): void
  setBounds(
    tabId: string,
    targetWindow: unknown,
    bounds: { x: number; y: number; width: number; height: number }
  ): void
  clickTab(
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): void
  typeTab(tabId: string, text: string, key?: string): void
  scrollTab(tabId: string, dx: number, dy: number): Promise<void>
  showCursor(tabId: string, x: number, y: number, opts?: { pulse?: boolean }): Promise<void>
  getClickables(tabId: string): Promise<unknown | null>
  capturePage(
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<{ data: string; format: 'jpeg' | 'png' } | null>
  getDom(tabId: string): Promise<string | null>
}
