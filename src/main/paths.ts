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
// 'electron'` here would force the bundler to resolve it; a
// `createRequire` call at use-time hides the lookup until we already
// know we're inside Electron. `createRequire` works in both the
// electron-vite CJS output and any future ESM output — `eval('require')`
// was the prior attempt and it broke under CJS because `require` is
// module-local there, not global.

import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
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

function loadElectronApp(): {
  getPath: (name: string) => string
  getAppPath: () => string
  isPackaged: boolean
} {
  const dynamicRequire = createRequire(__filename)
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

/** Resolve a bundled MCP script by filename. Three runtime layouts:
 *  - Packaged Electron: electron-builder copies scripts to process.resourcesPath.
 *  - Headless tarball (scripts/pack-headless.mjs): bundle is at lib/main/,
 *    scripts are in sibling lib/mcp/.
 *  - Dev (Electron unpackaged): __dirname is out/main/, scripts live in
 *    resources/ at the repo root.
 *  Lives here (not mcp-config.ts) so callers don't pick up control-server's
 *  transitive worktree.ts → git-ops-state.ts import chain. */
export function resolveBundledMcpScript(name: string): string {
  if (isPackaged()) return join(process.resourcesPath, name)
  if (detectRuntime() === 'node') return join(__dirname, '..', 'mcp', name)
  return join(__dirname, '..', '..', 'resources', name)
}

/** Resolve a script shipped from the repo's `scripts/` dir (Electron-only
 *  callers — currently the SSH bootstrap). Two layouts:
 *   - Packaged: electron-builder copies it to `process.resourcesPath`
 *     (see the `extraResources` entry in package.json).
 *   - Dev (unpackaged Electron): it lives in the live source tree under
 *     `<appPath>/scripts/`.
 *  Anchored on `app.getAppPath()` rather than `__dirname` because callers
 *  may be lazy-`import()`ed into `out/main/chunks/`, where relative
 *  `__dirname` math is one (or more) levels off. */
export function resolveBundledScript(name: string): string {
  if (isPackaged()) return join(process.resourcesPath, name)
  return join(loadElectronApp().getAppPath(), 'scripts', name)
}

/** Directory to search for locally-staged `harness-server` tarballs that
 *  upload-mode provisioning can push to a remote (instead of the remote
 *  pulling from GitHub). Symmetric with `resolveBundledScript`:
 *   - Packaged: a `headless/` subdir under `process.resourcesPath`,
 *     populated opt-in by `scripts/stage-server-tarballs.mjs` (the
 *     `pack:servers` npm script). A default build ships this dir empty, so
 *     the lookup finds nothing and the bootstrap falls back to download
 *     mode — no ~130MB-per-platform bloat unless you ask for it.
 *   - Dev (unpackaged Electron): the repo's `release/headless/`, where
 *     `pack:headless*` writes tarballs.
 *  Returns null in headless/node mode (SSH bootstrap is Electron-only). */
export function resolveBundledServerDir(): string | null {
  if (detectRuntime() !== 'electron') return null
  if (isPackaged()) return join(process.resourcesPath, 'headless')
  return join(loadElectronApp().getAppPath(), 'release', 'headless')
}
