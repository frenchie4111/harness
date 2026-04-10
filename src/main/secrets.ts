import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from './debug'

/** File on disk where encrypted secrets are stored */
function getSecretsPath(): string {
  return join(app.getPath('userData'), 'secrets.enc')
}

interface SecretsFile {
  // base64-encoded ciphertext for each key
  [key: string]: string
}

function readSecretsFile(): SecretsFile {
  const p = getSecretsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    log('secrets', 'failed to read secrets file', err instanceof Error ? err.message : err)
    return {}
  }
}

function writeSecretsFile(data: SecretsFile): void {
  try {
    writeFileSync(getSecretsPath(), JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (err) {
    log('secrets', 'failed to write secrets file', err instanceof Error ? err.message : err)
  }
}

/** Store a secret, encrypted with the OS keychain via Electron safeStorage */
export function setSecret(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    log('secrets', 'safeStorage encryption not available, refusing to store')
    return
  }
  const data = readSecretsFile()
  const encrypted = safeStorage.encryptString(value).toString('base64')
  data[key] = encrypted
  writeSecretsFile(data)
}

/** Retrieve a secret, decrypting with the OS keychain */
export function getSecret(key: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const data = readSecretsFile()
  const encrypted = data[key]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch (err) {
    log('secrets', `failed to decrypt secret ${key}`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Check if a secret exists without decrypting it */
export function hasSecret(key: string): boolean {
  const data = readSecretsFile()
  return key in data && !!data[key]
}

/** Remove a secret */
export function deleteSecret(key: string): void {
  const data = readSecretsFile()
  delete data[key]
  writeSecretsFile(data)
}
