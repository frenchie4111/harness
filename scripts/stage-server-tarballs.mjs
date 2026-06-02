#!/usr/bin/env node
// Stage locally-built harness-server tarballs into resources/headless/ so a
// packaged build can carry them (opt-in) and upload-provision remotes offline.
//
//   npm run bundle:servers                 # stage every built tarball
//   npm run bundle:servers -- linux-x64    # just one (or more) platforms
//   npm run bundle:servers -- linux/amd64  # docker-style tags accepted too
//
// `pack:servers` runs this before electron-builder; the extraResources entry
// `{ from: 'resources/headless', to: 'headless', filter: [*.tar.gz*] }` then
// copies whatever landed here into the app. A default `pack`/`dist` skips
// this script, so resources/headless/ stays empty and the build carries no
// extra payload. At runtime resolveBundledServerDir() finds these under
// process.resourcesPath/headless.

import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(repoRoot, 'release', 'headless')
const destDir = join(repoRoot, 'resources', 'headless')

const KNOWN_PLATFORMS = ['darwin-arm64', 'linux-x64', 'linux-arm64']

// Normalize args: accept `linux-x64` or docker-style `linux/amd64`.
function normalizePlatform(arg) {
  if (arg === 'linux/amd64') return 'linux-x64'
  if (arg === 'linux/arm64') return 'linux-arm64'
  if (KNOWN_PLATFORMS.includes(arg)) return arg
  throw new Error(`unknown platform '${arg}' (expected one of: ${KNOWN_PLATFORMS.join(', ')}, or linux/amd64, linux/arm64)`)
}

const wanted = process.argv.slice(2).map(normalizePlatform)

function matchesWanted(name) {
  if (wanted.length === 0) return true
  return wanted.some((p) => name.endsWith(`-${p}.tar.gz`))
}

if (!existsSync(srcDir)) {
  console.error(`error: ${srcDir} does not exist — build tarballs first (npm run pack:headless:all)`)
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })

// Clear any previously-staged tarballs so a re-run doesn't leave stale
// platforms behind (the .gitkeep and anything non-tarball is left alone).
for (const name of readdirSync(destDir)) {
  if (name.endsWith('.tar.gz') || name.endsWith('.tar.gz.sha256')) {
    rmSync(join(destDir, name))
  }
}

const tarballs = readdirSync(srcDir).filter(
  (n) => n.startsWith('harness-server-') && n.endsWith('.tar.gz') && matchesWanted(n)
)

if (tarballs.length === 0) {
  const hint = wanted.length ? ` matching ${wanted.join(', ')}` : ''
  console.error(`error: no harness-server tarballs${hint} in ${srcDir} — build them with npm run pack:headless:all`)
  process.exit(1)
}

let staged = 0
for (const name of tarballs) {
  copyFileSync(join(srcDir, name), join(destDir, name))
  const sizeMb = (statSync(join(destDir, name)).size / (1024 * 1024)).toFixed(0)
  const sha = `${name}.sha256`
  if (existsSync(join(srcDir, sha))) {
    copyFileSync(join(srcDir, sha), join(destDir, sha))
  }
  console.log(`staged ${name} (${sizeMb} MB)`)
  staged++
}
console.log(`\n${staged} tarball(s) staged in resources/headless/ — will be bundled into the next packaged build.`)
