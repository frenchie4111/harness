import { BrowserWindow, ipcMain } from 'electron'

// Window control IPC handlers. These bypass the transport layer because
// in remote-Electron mode the transport routes to the remote
// harness-server, but the BrowserWindow being controlled is local. The
// preload calls these via ipcRenderer.send regardless of mode.
export function registerWindowControlHandlers(): void {
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
