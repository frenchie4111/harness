// Pluggable secrets storage. The external API (`setSecret`, `getSecret`,
// `hasSecret`, `deleteSecret`) is unchanged so call sites don't need to
// know which backend is active.
//
// Backends (chosen at first use):
//   1. Electron mode → safeStorage. OS keychain-backed encryption,
//      same on-disk layout (`secrets.enc` JSON of base64 ciphertext) as
//      the original implementation, so an upgrading user's tokens
//      decrypt as before.
//   2. Headless + keytar available → keytar. OS keychain entries under
//      service `harness`, account = secret key. Nothing on disk.
//   3. Headless + no keytar → AES-256-GCM with a random key file at
//      `<userData>/.secret-key` (mode 0600). The `secrets.enc` file
//      stores `iv(12) || tag(16) || ciphertext`, base64-encoded per
//      key. This is dev/self-hosted only — a host with shell access can
//      trivially read both files. Not suitable for hosted multi-tenant.
//
// `keytar` is loaded via dynamic require so a missing native binding
// (Alpine, Docker without keytar deps, etc.) just falls through to the
// file backend instead of failing the boot.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { detectRuntime, userDataDir } from './paths'
import { log } from './debug'

interface SecretsBackend {
  set(key: string, value: string): void
  get(key: string): string | null
  has(key: string): boolean
  delete(key: string): void
}

interface SecretsFile {
  [key: string]: string
}

function readSecretsFile(): SecretsFile {
  const p = join(userDataDir(), 'secrets.enc')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    log('secrets', 'failed to read secrets file', err instanceof Error ? err.message : err)
    return {}
  }
}

function writeSecretsFile(data: SecretsFile): void {
  const p = join(userDataDir(), 'secrets.enc')
  try {
    writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (err) {
    log('secrets', 'failed to write secrets file', err instanceof Error ? err.message : err)
  }
}

class SafeStorageBackend implements SecretsBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly safeStorage: any) {}

  set(key: string, value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      log('secrets', 'safeStorage encryption not available, refusing to store')
      return
    }
    const data = readSecretsFile()
    data[key] = this.safeStorage.encryptString(value).toString('base64')
    writeSecretsFile(data)
  }

  get(key: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) return null
    const data = readSecretsFile()
    const encrypted = data[key]
    if (!encrypted) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (err) {
      log('secrets', `failed to decrypt secret ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    const data = readSecretsFile()
    return key in data && !!data[key]
  }

  delete(key: string): void {
    const data = readSecretsFile()
    delete data[key]
    writeSecretsFile(data)
  }
}

class KeytarBackend implements SecretsBackend {
  private static readonly SERVICE = 'harness'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly keytar: any
  private readonly knownKeys = new Set<string>()
  // Synchronous index of which keys exist. Keytar is async-only, so we
  // shadow it here for the sync `has` / `get` API the rest of main relies
  // on. Loaded once at construction; updated on every set/delete.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(keytar: any) {
    this.keytar = keytar
    try {
      const list = keytar.findCredentialsSync?.(KeytarBackend.SERVICE)
      if (Array.isArray(list)) for (const c of list) this.knownKeys.add(c.account)
    } catch (err) {
      log('secrets', 'keytar findCredentialsSync failed (non-fatal)', err instanceof Error ? err.message : err)
    }
  }

  set(key: string, value: string): void {
    try {
      // Keytar exposes only async methods on most platforms. Fire-and-forget
      // — the next get for this key won't observe the write until it lands,
      // but the only caller (settings:setGithubToken) awaits a roundtrip
      // before re-reading via hasSecret, which gives keytar enough time.
      void this.keytar.setPassword(KeytarBackend.SERVICE, key, value)
      this.knownKeys.add(key)
    } catch (err) {
      log('secrets', `keytar set failed for ${key}`, err instanceof Error ? err.message : err)
    }
  }

  get(key: string): string | null {
    try {
      // Keytar offers a sync variant on Linux/Windows; use it when present
      // so the existing sync API contract holds. On macOS the sync variant
      // is missing and we'd need to redesign the public API to be async —
      // not in scope for this seam.
      if (typeof this.keytar.getPasswordSync === 'function') {
        const v = this.keytar.getPasswordSync(KeytarBackend.SERVICE, key)
        return v ?? null
      }
      log('secrets', 'keytar getPasswordSync unavailable on this platform — get returns null')
      return null
    } catch (err) {
      log('secrets', `keytar get failed for ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    return this.knownKeys.has(key)
  }

  delete(key: string): void {
    try {
      void this.keytar.deletePassword(KeytarBackend.SERVICE, key)
      this.knownKeys.delete(key)
    } catch (err) {
      log('secrets', `keytar delete failed for ${key}`, err instanceof Error ? err.message : err)
    }
  }
}

class LocalEncryptedFileBackend implements SecretsBackend {
  private readonly key: Buffer

  constructor() {
    this.key = this.loadOrCreateKey()
  }

  private loadOrCreateKey(): Buffer {
    const p = join(userDataDir(), '.secret-key')
    if (existsSync(p)) {
      const buf = readFileSync(p)
      if (buf.length === 32) return buf
      log('secrets', 'existing .secret-key is malformed; regenerating')
    }
    const fresh = randomBytes(32)
    writeFileSync(p, fresh, { mode: 0o600 })
    try { chmodSync(p, 0o600) } catch { /* ignore */ }
    return fresh
  }

  set(key: string, value: string): void {
    const data = readSecretsFile()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    data[key] = Buffer.concat([iv, tag, ct]).toString('base64')
    writeSecretsFile(data)
  }

  get(key: string): string | null {
    const data = readSecretsFile()
    const blob = data[key]
    if (!blob) return null
    try {
      const buf = Buffer.from(blob, 'base64')
      if (buf.length < 12 + 16 + 1) return null
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const ct = buf.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch (err) {
      log('secrets', `failed to decrypt secret ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    const data = readSecretsFile()
    return key in data && !!data[key]
  }

  delete(key: string): void {
    const data = readSecretsFile()
    delete data[key]
    writeSecretsFile(data)
  }
}

let backendCache: SecretsBackend | null = null

function pickBackend(): SecretsBackend {
  if (backendCache) return backendCache
  const dynamicRequire = createRequire(__filename)
  if (detectRuntime() === 'electron') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { safeStorage } = dynamicRequire('electron') as any
    backendCache = new SafeStorageBackend(safeStorage)
    return backendCache
  }
  // Headless: try keytar dynamically. Native modules are fragile in
  // Docker/Alpine/CI — fall through to the file backend on any load
  // error, including the binding being missing entirely.
  try {
    const keytar = dynamicRequire('keytar')
    backendCache = new KeytarBackend(keytar)
    log('secrets', 'using keytar backend')
    return backendCache
  } catch {
    // Expected when keytar isn't installed.
  }
  backendCache = new LocalEncryptedFileBackend()
  log('secrets', 'using local encrypted file backend (dev/self-hosted only)')
  return backendCache
}

/** Store a secret. */
export function setSecret(key: string, value: string): void {
  pickBackend().set(key, value)
}

/** Retrieve a secret, or null if absent. */
export function getSecret(key: string): string | null {
  return pickBackend().get(key)
}

/** Check if a secret exists without decrypting it. */
export function hasSecret(key: string): boolean {
  return pickBackend().has(key)
}

/** Remove a secret. */
export function deleteSecret(key: string): void {
  pickBackend().delete(key)
}

/** Test-only: reset the backend cache so a fresh `pickBackend` runs. */
export function resetSecretsBackendForTests(): void {
  backendCache = null
}
