// The WS/web-client auth token lives in the encrypted secrets store so
// it survives main-process restarts. That lets users pin a web-client
// URL to their phone's homescreen or bookmark it and have the link
// keep working across reboots. When safeStorage is unavailable (rare
// — only headless CI and Linux without a keyring), setSecret silently
// no-ops and we fall back to a fresh token on every boot, matching
// the pre-persistence behavior.
//
// `HARNESS_AUTH_TOKEN` env var, when set, takes precedence over the
// persisted secret. This is what the local Harness's SSH bootstrap
// (`src/main/ssh-bootstrap.ts`) uses to dictate a known token to a
// freshly-launched remote `harness-server` so the local WS client
// can authenticate without having to fish anything out of the remote.
// The env var is intentionally NOT written back to the secret store —
// a server launched without the env var still gets its previously-
// persisted token, so manual `harness-server` runs aren't disturbed.

import { randomBytes } from 'crypto'
import { getSecret, setSecret } from './secrets'

const SECRET_KEY = 'wsAuthToken'

export function getOrCreateWsToken(): string {
  const fromEnv = process.env.HARNESS_AUTH_TOKEN
  if (fromEnv) return fromEnv
  const existing = getSecret(SECRET_KEY)
  if (existing) return existing
  return rotateWsToken()
}

export function rotateWsToken(): string {
  const token = randomBytes(32).toString('hex')
  setSecret(SECRET_KEY, token)
  return token
}
