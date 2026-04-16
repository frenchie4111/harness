import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'

export function registerStateTransport(store: Store, perfMonitor?: PerfMonitor): void {
  ipcMain.handle('state:getSnapshot', () => {
    return store.getSnapshot()
  })

  store.subscribe((event, seq) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        perfMonitor?.recordIpcMessage()
        win.webContents.send('state:event', event, seq)
      }
    }
  })
}
