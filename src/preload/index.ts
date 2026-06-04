// The preload's job is now narrow: expose just enough to the renderer
// for it to talk to the local Electron main process. Everything else
// (the ~200-method `window.api` surface) lives in
// `src/renderer/build-backend.ts` so that remote backends — whose
// transport is a renderer-living WebSocketClientTransport — can route
// through it without an extra bridge crossing.
//
// Two things only get exposed via contextBridge:
//
//   1. `window.__harness_local_transport` — a duck-typed
//      ClientTransport for the in-process local backend. Wraps
//      ipcRenderer (which is preload-only). The renderer's
//      BackendsRegistry wires it to the local backend's mirrored
//      ClientStore; the renderer-built backend uses it for
//      always-local concerns (connections list, menu signals,
//      window controls).
//
//   2. `window.__harness_electron_helpers` — Electron-only APIs
//      that genuinely can't live in the renderer (webUtils for
//      drag-drop file paths, ipcRenderer.send for window controls
//      that target the local BrowserWindow).
//
// Plus `window.__HARNESS_PLATFORM__` (process.platform — used by
// renderer to render Linux-only window controls) and
// `window.__HARNESS_WEB__ = false` (legacy flag, kept until renderer
// boot-error UI is migrated).

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { ElectronClientTransport } from './transport-electron'
import type {
  ClientTransport,
  LocalTransportHandle,
  ElectronOnlyHelpers
} from '../shared/transport/transport'

const transport: ClientTransport = new ElectronClientTransport()

const localTransportHandle: LocalTransportHandle = {
  getStateSnapshot: () => transport.getStateSnapshot(),
  onStateEvent: (cb) => transport.onStateEvent((event, seq) => cb(event, seq)),
  request: (name, ...args) => transport.request(name, ...args),
  send: (name, ...args) => transport.send(name, ...args),
  onSignal: (name, handler) => transport.onSignal(name, handler),
  getClientId: () => transport.getClientId(),
  onReconnect: (cb) => transport.onReconnect(cb)
}
contextBridge.exposeInMainWorld('__harness_local_transport', localTransportHandle)

const electronHelpers: ElectronOnlyHelpers = {
  getFilePath: (file) => webUtils.getPathForFile(file),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  windowClose: () => ipcRenderer.send('window:close')
}
contextBridge.exposeInMainWorld('__harness_electron_helpers', electronHelpers)

contextBridge.exposeInMainWorld('__HARNESS_WEB__', false)
contextBridge.exposeInMainWorld('__HARNESS_PLATFORM__', process.platform)
