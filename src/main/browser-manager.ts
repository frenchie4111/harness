import { WebContentsView, BrowserWindow, session } from 'electron'
import type { Store } from './store'
import { log } from './debug'

export interface BrowserInstance {
  view: WebContentsView
  worktreePath: string
  attachedWindow: BrowserWindow | null
  logs: ConsoleLog[]
  /** Track the last-applied bounds so we can skip redundant setBounds calls. */
  lastBounds: { x: number; y: number; width: number; height: number } | null
  /** When false, the view is detached (removed from the window) and bounds
   * updates will re-attach it. */
  visible: boolean
}

export interface ConsoleLog {
  ts: number
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  message: string
}

const CONSOLE_LOG_CAP = 200

function sanitizePartition(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

/**
 * Owns `WebContentsView` instances keyed by browser tab id. Each tab gets
 * its own persistent session partition scoped to its worktree so cookies /
 * localStorage don't leak between worktrees.
 *
 * The renderer sends bounds updates (placeholder div geometry) via IPC; we
 * reposition the underlying view over the BrowserWindow's content area.
 */
export class BrowserManager {
  private instances = new Map<string, BrowserInstance>()
  private store: Store | null = null

  setStore(store: Store): void {
    this.store = store
  }

  hasTab(tabId: string): boolean {
    return this.instances.has(tabId)
  }

  listAllTabIds(): string[] {
    return [...this.instances.keys()]
  }

  getWorktreePath(tabId: string): string | null {
    return this.instances.get(tabId)?.worktreePath ?? null
  }

  /** Return all tab ids whose worktreePath matches. */
  listTabsForWorktree(worktreePath: string): string[] {
    const out: string[] = []
    for (const [id, inst] of this.instances) {
      if (inst.worktreePath === worktreePath) out.push(id)
    }
    return out
  }

  getConsoleLogs(tabId: string): ConsoleLog[] {
    return this.instances.get(tabId)?.logs.slice() ?? []
  }

  getUrl(tabId: string): string | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return inst.view.webContents.getURL()
  }

  create(tabId: string, worktreePath: string, url: string): void {
    if (this.instances.has(tabId)) return
    log('browser', `create tab=${tabId} wt=${worktreePath} url=${url}`)
    const part = `persist:wt-${sanitizePartition(worktreePath)}`
    const ses = session.fromPartition(part)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    view.setBackgroundColor('#00000000')

    const inst: BrowserInstance = {
      view,
      worktreePath,
      attachedWindow: null,
      logs: [],
      lastBounds: null,
      visible: false
    }
    this.instances.set(tabId, inst)
    this.wireEvents(tabId, inst)

    const initialUrl = url && url.trim() ? url : 'about:blank'
    this.dispatchState(tabId, { url: initialUrl, loading: true })
    view.webContents.loadURL(initialUrl).catch((err) => {
      log('browser', `loadURL failed tab=${tabId}`, err instanceof Error ? err.message : err)
    })
  }

  private wireEvents(tabId: string, inst: BrowserInstance): void {
    const wc = inst.view.webContents
    const nav = (): void => {
      this.dispatchState(tabId, {
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    }
    wc.on('did-navigate', nav)
    wc.on('did-navigate-in-page', nav)
    wc.on('did-start-loading', () => {
      this.dispatchState(tabId, { loading: true })
    })
    wc.on('did-stop-loading', () => {
      this.dispatchState(tabId, {
        loading: false,
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    })
    wc.on('page-title-updated', (_e, title) => {
      this.dispatchState(tabId, { title })
    })
    wc.on('console-message', (event) => {
      const levelMap: Record<string, ConsoleLog['level']> = {
        verbose: 'debug',
        info: 'info',
        warning: 'warn',
        error: 'error'
      }
      const level = levelMap[event.level] ?? 'log'
      inst.logs.push({ ts: Date.now(), level, message: event.message })
      while (inst.logs.length > CONSOLE_LOG_CAP) inst.logs.shift()
    })
  }

  private dispatchState(tabId: string, patch: Partial<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }>): void {
    this.store?.dispatch({
      type: 'browser/tabStateChanged',
      payload: { tabId, state: patch }
    })
  }

  destroy(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    log('browser', `destroy tab=${tabId}`)
    this.detachView(inst)
    try {
      inst.view.webContents.close()
    } catch {
      // already gone
    }
    this.instances.delete(tabId)
    this.store?.dispatch({ type: 'browser/tabRemoved', payload: tabId })
  }

  destroyAllForWorktree(worktreePath: string): void {
    for (const [id, inst] of [...this.instances]) {
      if (inst.worktreePath === worktreePath) this.destroy(id)
    }
  }

  navigate(tabId: string, url: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const target = url.trim()
    if (!target) return
    const normalized = /^[a-z][a-z0-9+\-.]*:/i.test(target) ? target : `https://${target}`
    inst.view.webContents.loadURL(normalized).catch((err) => {
      log('browser', `navigate failed tab=${tabId}`, err instanceof Error ? err.message : err)
    })
  }

  back(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.navigationHistory.canGoBack()) {
      inst.view.webContents.navigationHistory.goBack()
    }
  }

  forward(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.navigationHistory.canGoForward()) {
      inst.view.webContents.navigationHistory.goForward()
    }
  }

  reload(tabId: string): void {
    this.instances.get(tabId)?.view.webContents.reload()
  }

  openDevTools(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.isDevToolsOpened()) {
      inst.view.webContents.closeDevTools()
    } else {
      inst.view.webContents.openDevTools({ mode: 'detach' })
    }
  }

  setBounds(
    tabId: string,
    targetWindow: BrowserWindow,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const rounded = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    if (!inst.visible || inst.attachedWindow !== targetWindow) {
      this.detachView(inst)
      targetWindow.contentView.addChildView(inst.view)
      inst.attachedWindow = targetWindow
      inst.visible = true
    }
    if (
      !inst.lastBounds ||
      inst.lastBounds.x !== rounded.x ||
      inst.lastBounds.y !== rounded.y ||
      inst.lastBounds.width !== rounded.width ||
      inst.lastBounds.height !== rounded.height
    ) {
      inst.view.setBounds(rounded)
      inst.lastBounds = rounded
    }
  }

  hide(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    this.detachView(inst)
  }

  private detachView(inst: BrowserInstance): void {
    if (!inst.visible || !inst.attachedWindow) return
    try {
      inst.attachedWindow.contentView.removeChildView(inst.view)
    } catch {
      // window may have been destroyed
    }
    inst.attachedWindow = null
    inst.visible = false
    inst.lastBounds = null
  }

  async capturePage(tabId: string): Promise<string | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      const image = await inst.view.webContents.capturePage()
      return image.toPNG().toString('base64')
    } catch (err) {
      log('browser', `capturePage failed tab=${tabId}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  async getDom(tabId: string): Promise<string | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      const result = await inst.view.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      )
      return typeof result === 'string' ? result : null
    } catch (err) {
      log('browser', `getDom failed tab=${tabId}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  getTabInfo(tabId: string): { id: string; url: string; title: string } | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return {
      id: tabId,
      url: inst.view.webContents.getURL(),
      title: inst.view.webContents.getTitle()
    }
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) this.destroy(id)
  }
}
