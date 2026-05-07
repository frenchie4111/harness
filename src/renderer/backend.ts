// Renderer-side backend accessor. Holds the singleton built by
// `initBackend()` (called from initStore) and serves it via two
// equivalent shapes:
//
//   import { useBackend } from '@/backend'   // React components / hooks
//   import { getBackend } from '@/backend'   // module-level / non-React
//
// The hook is the idiomatic React shape; the getter exists because a
// few call sites (XTerminal's font-cache module init, the take-control
// diagnostic, the error boundary) aren't inside React.
//
// Each method on the returned object lazily reads
// `registry.getActiveTransport()` and dispatches the call there, so
// switching backends instantly redirects subsequent commands. Local
// active goes through the preload's local-transport handle (1
// contextBridge crossing — same as the original `window.api`). Remote
// active goes through the renderer-living WebSocketClientTransport
// directly (0 crossings — same as the standalone web client).

import type { ElectronAPI } from './types'
import type {
  ElectronOnlyHelpers,
  LocalTransportHandle
} from '../shared/transport/transport'
import { buildBackend } from './build-backend'

let backend: ElectronAPI | null = null

declare global {
  interface Window {
    /** Preload-only Electron helpers (webUtils.getPathForFile,
     *  ipcRenderer-backed window controls). Null in the web client. */
    __harness_electron_helpers?: ElectronOnlyHelpers
  }
}

export function initBackend(opts: {
  getActiveTransport: () => LocalTransportHandle
  getLocalTransport: () => LocalTransportHandle
}): void {
  const electronHelpers = window.__harness_electron_helpers ?? null
  backend = buildBackend(opts.getActiveTransport, opts.getLocalTransport, electronHelpers)
}

export function getBackend(): ElectronAPI {
  if (!backend) {
    throw new Error('backend accessed before initBackend() — call initStore() first')
  }
  return backend
}

/** React-side accessor. Returns the same module-scoped singleton as
 *  `getBackend()` — no context, no per-render allocation. The hook
 *  shape is here so React components have an idiomatic call site and
 *  so we have a seam for per-tree overrides later (testing, multi-
 *  window) without touching call sites. */
export function useBackend(): ElectronAPI {
  return getBackend()
}
