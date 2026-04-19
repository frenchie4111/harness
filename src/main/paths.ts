// Cross-runtime path resolution. The same modules (persistence, debug,
// secrets, mcp-config, activity) need to know where to read/write their
// JSON blobs whether main is hosted inside Electron or running headless
// under plain Node.
//
// Mode is detected at first call via `process.versions.electron`, which
// is set by Electron and absent under Node. No config-file gymnastics —
// the runtime picks itself.
//
// Electron mode: delegate to `app.getPath('userData')`. The dev-mode
// override (`Harness (Dev)` user-data dir) lives in the desktop shell's
// boot block — by the time anything in this module runs it has already
// been applied.
//
// Headless mode: use $HARNESS_DATA_DIR, defaulting to ~/.harness. The
// directory is created on first use with mode 0700 so secrets dropped
// alongside config can't be world-readable.
//
// Why dynamic-require for `electron`: the headless bundle is built
// without Electron on the load path. A static `import { app } from
// 'electron'` here would force the bundler to resolve it; an
// `eval('require')` at call time hides the lookup until we already
// know we're inside Electron.

import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Runtime = 'electron' | 'node'

export function detectRuntime(): Runtime {
  return process.versions.electron ? 'electron' : 'node'
}

let cachedUserDataDir: string | null = null

function ensureDir(dir: string, mode = 0o700): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode })
  }
  return dir
}

function loadElectronApp(): { getPath: (name: string) => string; isPackaged: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicRequire = (0, eval)('require') as (id: string) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (dynamicRequire('electron') as any).app
}

/** Absolute path to the directory we read/write app data from. Same role
 *  as Electron's `userData`, just resolvable in both runtimes. */
export function userDataDir(): string {
  if (cachedUserDataDir) return cachedUserDataDir
  if (detectRuntime() === 'electron') {
    cachedUserDataDir = loadElectronApp().getPath('userData')
  } else {
    const fromEnv = process.env['HARNESS_DATA_DIR']
    const dir = fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), '.harness')
    cachedUserDataDir = ensureDir(dir)
  }
  return cachedUserDataDir
}

/** True when the host process is the packaged production Electron build.
 *  Always false under Node (there is no notion of "packaged" headlessly). */
export function isPackaged(): boolean {
  if (detectRuntime() !== 'electron') return false
  return loadElectronApp().isPackaged
}

/** Reset the cached directory. Tests use this to get a fresh resolution
 *  after mutating $HARNESS_DATA_DIR between cases. Production code
 *  should never need it. */
export function resetPathsForTests(): void {
  cachedUserDataDir = null
}
