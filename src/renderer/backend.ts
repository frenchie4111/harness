// Renderer-side backend accessor. Replaces what used to be
// `window.api`, which lived in the preload and routed through a
// preload-side `currentImpl` (the source of the contextBridge
// double-cross perf bug for remote backends — see commit history).
//
// Now: `window.api` is built in renderer context, with each method
// calling `registry.getActiveTransport()` lazily so the active
// backend's transport always handles the call. Local routes through
// the preload's local transport handle (1 bridge crossing — same as
// today). Remote routes through the renderer-living
// WebSocketClientTransport directly (0 bridge crossings — same as
// the standalone web client).
//
// Shape:
//   import { useBackend } from '@/backend'   // for React components
//   import { getBackend } from '@/backend'   // for module-level / non-React
//
// Both return the same module-scoped singleton. The hook is the
// idiomatic React shape; the getter exists because some call sites
// (XTerminal's font cache subscribes at module-eval time, take-control
// diagnostic in initStore, error boundary's logError) aren't inside
// React.
//
// `window.api` continues to exist as a backward-compat alias set by
// `initBackend()` so we don't have to migrate ~200 call sites in one
// commit. Migration to `useBackend()`/`getBackend()` is a follow-up.

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
  // Backward-compat alias so existing `window.api.X(...)` call sites keep
  // working until migrated to `useBackend()` / `getBackend()`. Set as a
  // plain renderer-side property (not via contextBridge), so it lives
  // entirely in renderer context — no bridge crossings just to reach it.
  ;(window as unknown as { api: ElectronAPI }).api = backend
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
