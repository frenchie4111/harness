// The WS/web-client auth token lives in the encrypted secrets store so
// it survives main-process restarts. That lets users pin a web-client
// URL to their phone's homescreen or bookmark it and have the link
// keep working across reboots. When safeStorage is unavailable (rare
// — only headless CI and Linux without a keyring), setSecret silently
// no-ops and we fall back to a fresh token on every boot, matching
// the pre-persistence behavior.

import { randomBytes } from 'crypto'
import { getSecret, setSecret } from './secrets'

const SECRET_KEY = 'wsAuthToken'

export function getOrCreateWsToken(): string {
  const existing = getSecret(SECRET_KEY)
  if (existing) return existing
  return rotateWsToken()
}

export function rotateWsToken(): string {
  const token = randomBytes(32).toString('hex')
  setSecret(SECRET_KEY, token)
  return token
}
