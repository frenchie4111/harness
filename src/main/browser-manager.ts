import { WebContentsView, BrowserWindow, session } from 'electron'
import type { Store } from './store'
import type { BrowserManagerLike, ConsoleLog } from './browser-manager-types'
import { log } from './debug'
import { resolveScreenshotTarget } from './browser-screenshot'

export type { ConsoleLog }

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

const CONSOLE_LOG_CAP = 200

function sanitizePartition(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

const SPECIAL_KEYS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space'
}

function mapSpecialKey(key: string): string | null {
  return SPECIAL_KEYS[key.trim().toLowerCase()] ?? null
}

const CLICKABLES_SCRIPT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[onclick]';
  const MAX = 500;
  function clip(s) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, 100); }
  function getRole(el) {
    const ex = el.getAttribute('role');
    if (ex) return ex;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = ((el.type || 'text') + '').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    return tag;
  }
  function getName(el) {
    const al = el.getAttribute('aria-label');
    if (al) return clip(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const txt = lb.split(/\\s+/).map(id => {
        const n = document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' ');
      if (txt.trim()) return clip(txt);
    }
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent) return clip(lbl.textContent);
      } catch (e) {}
    }
    const wrap = el.closest && el.closest('label');
    if (wrap && wrap.textContent) return clip(wrap.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (el.placeholder) return clip(el.placeholder);
      if (el.value) return clip(el.value);
    }
    if (tag === 'img' && el.alt) return clip(el.alt);
    const txt = el.textContent;
    if (txt && txt.trim()) return clip(txt);
    if (el.title) return clip(el.title);
    return '';
  }
  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const op = parseFloat(s.opacity);
    if (!isNaN(op) && op === 0) return false;
    return true;
  }
  const queue = [document];
  const items = [];
  const seen = new Set();
  let truncated = false;
  outer: while (queue.length) {
    const node = queue.shift();
    const matches = node.querySelectorAll(SEL);
    for (const el of matches) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!isVisible(el)) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
      items.push({
        role: getRole(el),
        name: getName(el),
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
      if (items.length >= MAX) { truncated = true; break outer; }
    }
    const all = node.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot && el.shadowRoot.mode === 'open') queue.push(el.shadowRoot);
    }
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    pageHeight: Math.round(document.documentElement.scrollHeight),
    items,
    truncated
  };
})()`;

/**
 * Owns `WebContentsView` instances keyed by browser tab id. Each tab gets
 * its own persistent session partition scoped to its worktree so cookies /
 * localStorage don't leak between worktrees.
 *
 * The renderer sends bounds updates (placeholder div geometry) via IPC; we
 * reposition the underlying view over the BrowserWindow's content area.
 */
export class BrowserManager implements BrowserManagerLike {
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
    targetWindow: unknown,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const win = targetWindow as BrowserWindow
    const rounded = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    if (!inst.visible || inst.attachedWindow !== win) {
      this.detachView(inst)
      win.contentView.addChildView(inst.view)
      inst.attachedWindow = win
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

  clickTab(
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const wc = inst.view.webContents
    const button = options?.button ?? 'left'
    const clickCount = Math.max(1, Math.min(3, options?.clickCount ?? 1))
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount })
    void this.showCursor(tabId, x, y, { pulse: true })
  }

  typeTab(tabId: string, text: string, key?: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const wc = inst.view.webContents

    if (key) {
      const mapped = mapSpecialKey(key)
      if (mapped) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: mapped })
        wc.sendInputEvent({ type: 'keyUp', keyCode: mapped })
      }
    }

    if (text) {
      for (const ch of text) {
        if (ch === '\n') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          wc.sendInputEvent({ type: 'char', keyCode: '\r' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          continue
        }
        if (ch === '\t') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
          wc.sendInputEvent({ type: 'char', keyCode: '\t' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          continue
        }
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      }
    }
  }

  async scrollTab(tabId: string, deltaX: number, deltaY: number): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) return
    try {
      await inst.view.webContents.executeJavaScript(
        `window.scrollBy(${Number(deltaX) || 0}, ${Number(deltaY) || 0})`
      )
    } catch (err) {
      log('browser', `scrollTab failed tab=${tabId}`, err instanceof Error ? err.message : err)
    }
  }

  async showCursor(
    tabId: string,
    x: number,
    y: number,
    opts?: { pulse?: boolean }
  ): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const px = Math.round(Number(x) || 0)
    const py = Math.round(Number(y) || 0)
    const pulse = opts?.pulse ? 1 : 0
    const script = `(() => {
      const ID = '__harness_cursor__';
      let el = document.getElementById(ID);
      if (!el) {
        el = document.createElement('div');
        el.id = ID;
        el.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;transition:transform 60ms linear;will-change:transform;';
        el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M3 2 L17 13 L11 14 L8 21 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.transform = 'translate(${px}px,${py}px)';
      if (${pulse}) {
        const ringId = '__harness_cursor_ring__';
        let ring = document.getElementById(ringId);
        if (!ring) {
          ring = document.createElement('div');
          ring.id = ringId;
          ring.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;border-radius:9999px;pointer-events:none;z-index:2147483646;border:2px solid rgba(56,189,248,.9);background:rgba(56,189,248,.2);';
          (document.body || document.documentElement).appendChild(ring);
        }
        ring.style.transform = 'translate(${px - 10}px,${py - 10}px) scale(.4)';
        ring.style.opacity = '1';
        ring.animate(
          [
            { transform: 'translate(${px - 10}px,${py - 10}px) scale(.4)', opacity: 1 },
            { transform: 'translate(${px - 20}px,${py - 20}px) scale(2)', opacity: 0 }
          ],
          { duration: 380, easing: 'ease-out', fill: 'forwards' }
        );
      }
    })()`
    try {
      await inst.view.webContents.executeJavaScript(script)
    } catch (err) {
      log('browser', `showCursor failed tab=${tabId}`, err instanceof Error ? err.message : err)
    }
  }

  async getClickables(tabId: string): Promise<unknown | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      const result = await inst.view.webContents.executeJavaScript(CLICKABLES_SCRIPT)
      return result ?? null
    } catch (err) {
      log('browser', `getClickables failed tab=${tabId}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  async capturePage(
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<{ data: string; format: 'jpeg' | 'png' } | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      const image = await inst.view.webContents.capturePage()
      const bounds = inst.view.getBounds()
      const { outputSize } = resolveScreenshotTarget(bounds)
      const captured = image.getSize()
      const normalized =
        captured.width === outputSize.width && captured.height === outputSize.height
          ? image
          : image.resize({ width: outputSize.width, height: outputSize.height })
      const format = opts?.format === 'png' ? 'png' : 'jpeg'
      if (format === 'png') {
        return { data: normalized.toPNG().toString('base64'), format: 'png' }
      }
      const q = Math.max(1, Math.min(100, Math.round(opts?.quality ?? 70)))
      return { data: normalized.toJPEG(q).toString('base64'), format: 'jpeg' }
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
