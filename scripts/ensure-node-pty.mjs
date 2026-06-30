#!/usr/bin/env node
/**
 * node-pty on macOS/Linux spawns via a helper binary colocated with pty.node.
 * When electron-rebuild fails partway (common on machines missing libc++
 * headers), build/Release can end up with pty.node but no spawn-helper —
 * node-pty loads the broken Release dir first and every PTY spawn fails with
 * "posix_spawnp failed". Copy the platform prebuild pair when Release is
 * incomplete.
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ptyRoot = join(root, 'node_modules', 'node-pty')
const prebuildDir = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`)
const releaseDir = join(ptyRoot, 'build', 'Release')
const releasePty = join(releaseDir, 'pty.node')
const releaseHelper = join(releaseDir, 'spawn-helper')
const prebuildPty = join(prebuildDir, 'pty.node')
const prebuildHelper = join(prebuildDir, 'spawn-helper')

if (!existsSync(prebuildPty)) {
  console.warn(`[ensure-node-pty] no prebuild at ${prebuildDir}; skipping`)
  process.exit(0)
}

const releaseComplete =
  existsSync(releasePty) &&
  (process.platform === 'win32' || existsSync(releaseHelper))

if (releaseComplete) {
  process.exit(0)
}

console.log('[ensure-node-pty] repairing incomplete node-pty Release build from prebuilds')
mkdirSync(releaseDir, { recursive: true })
copyFileSync(prebuildPty, releasePty)
if (process.platform !== 'win32') {
  if (!existsSync(prebuildHelper)) {
    console.error(`[ensure-node-pty] missing ${prebuildHelper}`)
    process.exit(1)
  }
  copyFileSync(prebuildHelper, releaseHelper)
  chmodSync(releaseHelper, 0o755)
}
