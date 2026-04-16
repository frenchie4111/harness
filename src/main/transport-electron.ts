// Electron implementation of the shared ServerTransport interface.
//
// Wraps the existing ipcMain + webContents.send primitives so that the
// store, main-process handlers, and preload can all talk through a
// single abstraction. A future ServerTransport implementation (WebSocket,
// SSH stdio) slots in here without any call site above needing to change.

import { BrowserWindow, ipcMain } from 'electron'
import type { StateEvent } from '../shared/state'
import type {
  RequestHandler,
  ServerTransport,
  SignalHandler
} from '../shared/transport/transport'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'

export class ElectronServerTransport implements ServerTransport {
  private unsubscribeStore: (() => void) | null = null

  constructor(
    private readonly store: Store,
    private readonly perfMonitor?: PerfMonitor
  ) {}

  start(): void {
    ipcMain.handle('state:getSnapshot', () => this.store.getSnapshot())
    this.unsubscribeStore = this.store.subscribe((event, seq) => {
      this.broadcastStateEvent(event, seq)
    })
  }

  stop(): void {
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    ipcMain.removeHandler('state:getSnapshot')
  }

  broadcastStateEvent(event: StateEvent, seq: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        this.perfMonitor?.recordIpcMessage()
        win.webContents.send('state:event', event, seq)
      }
    }
  }

  onRequest(name: string, handler: RequestHandler): void {
    ipcMain.handle(name, async (_event, ...args) => handler(...args))
  }

  onSignal(name: string, handler: SignalHandler): void {
    ipcMain.on(name, (_event, ...args) => handler(...args))
  }

  sendSignal(name: string, ...args: unknown[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(name, ...args)
      }
    }
  }
}
