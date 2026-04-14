import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from './store'

export function registerStateTransport(store: Store): void {
  ipcMain.handle('state:getSnapshot', () => {
    return store.getSnapshot()
  })

  store.subscribe((event, seq) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('state:event', event, seq)
      }
    }
  })
}
