// Parse `~/.ssh/config` into the host list the AddBackendModal SSH tab
// presents. We don't try to fully honor ssh_config(5) semantics — we just
// surface the `Host` aliases the user has defined so the renderer can show
// them as picker options. The actual SSH connection still goes through
// node-ssh + ssh2, which DOES honor IdentityFile/User/Port/etc. via the
// underlying OpenSSH config.
//
// Wildcards (`Host *`, `Host *.foo.com`) are filtered out — they're glob
// patterns, not connectable hosts, and presenting them in a picker would
// just confuse the user.

import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import type SSHConfigType from 'ssh-config'
import type { Line } from 'ssh-config'

// SSH bootstrap is an Electron-only feature (only the local backend
// bootstraps remotes per plans/remote-main.md §4). The headless tarball
// doesn't ship `ssh-config`, so we lazy-load it via createRequire —
// the IPC handler is still registered in headless mode but never called,
// so the require never fires. If it ever does fire in headless, the
// surfaced error is "Cannot find module 'ssh-config'", which is the
// honest answer.
const dynamicRequire = createRequire(__filename)
function loadSshConfig(): { default: typeof SSHConfigType; LineType: typeof import('ssh-config').LineType } {
  return dynamicRequire('ssh-config')
}

export interface ConfiguredHost {
  /** The Host alias as written in the config file (the picker label). */
  alias: string
  /** Resolved HostName (falls back to `alias` if no HostName directive). */
  host: string
  /** Resolved User if set. */
  user?: string
  /** Resolved Port if set (number-coerced). */
  port?: number
  /** Resolved IdentityFile if set (first one wins — we don't multi-key). */
  identityFile?: string
}

function isWildcard(alias: string): boolean {
  return alias.includes('*') || alias.includes('?') || alias.includes('!')
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) return value[0]
  return value
}

/** Parse the given SSH config text into a list of connectable hosts.
 *  Exported separately from `listConfiguredHosts` so tests can feed
 *  literal text without touching disk. */
export function parseSshConfigText(text: string): ConfiguredHost[] {
  const { default: SSHConfig, LineType } = loadSshConfig()
  let parsed: InstanceType<typeof SSHConfig>
  try {
    parsed = SSHConfig.parse(text)
  } catch {
    return []
  }

  const hosts: ConfiguredHost[] = []
  // Dedupe by alias — users sometimes layer overrides with multiple
  // `Host build-box` blocks. ssh's first-match-wins means we keep the
  // first occurrence and skip the rest. Without this, the renderer
  // emits React-key warnings AND shows the same host twice in the
  // dropdown.
  const seen = new Set<string>()
  for (const line of parsed as Line[]) {
    if (line.type !== LineType.DIRECTIVE) continue
    if (line.param.toLowerCase() !== 'host') continue
    // `Host build-box dev-box` collapses into multiple aliases sharing
    // the same nested config block — ssh-config exposes the value as an
    // array in that case.
    const aliases: string[] = Array.isArray(line.value)
      ? line.value.map((v) => (typeof v === 'string' ? v : v.val))
      : [line.value]
    for (const alias of aliases) {
      if (!alias || isWildcard(alias)) continue
      if (seen.has(alias)) continue
      seen.add(alias)
      // `compute()` walks the file applying directives, so per-host
      // settings inherit from Match / Host * blocks the way ssh itself
      // resolves them. We just pull the resolved values out.
      let resolved: Record<string, string | string[]>
      try {
        resolved = parsed.compute(alias)
      } catch {
        // Malformed include or similar — best-effort: skip this alias.
        continue
      }
      const hostname = firstString(resolved.HostName) ?? alias
      const user = firstString(resolved.User)
      const portStr = firstString(resolved.Port)
      const port = portStr ? Number(portStr) : undefined
      const identityFile = firstString(resolved.IdentityFile)
      hosts.push({
        alias,
        host: hostname,
        ...(user ? { user } : {}),
        ...(port && Number.isFinite(port) ? { port } : {}),
        ...(identityFile ? { identityFile } : {})
      })
    }
  }
  return hosts
}

/** Resolve the effective ssh-config settings for an arbitrary host
 *  string — honors wildcard `Host *.foo.com` blocks the way `ssh`
 *  itself does, which the alias-list-based lookup can't (a freeform
 *  `mike@build.gradle.org` target wouldn't match a `Host *.gradle.org`
 *  entry by name, but `compute()` does because it's pattern-based).
 *
 *  Returns null when the config file is missing/unparsable or the host
 *  has no matching block. Caller (the SSH bootstrap) treats null as
 *  "no defaults, use the explicit target string verbatim + ssh-agent
 *  fallback." */
export async function computeForHost(host: string): Promise<{
  user?: string
  port?: number
  hostName?: string
  identityFile?: string
} | null> {
  const path = join(homedir(), '.ssh', 'config')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { default: SSHConfig } = loadSshConfig()
  let parsed: InstanceType<typeof SSHConfig>
  try {
    parsed = SSHConfig.parse(text)
  } catch {
    return null
  }
  let resolved: Record<string, string | string[]>
  try {
    resolved = parsed.compute(host)
  } catch {
    return null
  }
  const user = firstString(resolved.User)
  const portStr = firstString(resolved.Port)
  const port = portStr ? Number(portStr) : undefined
  const hostName = firstString(resolved.HostName)
  const identityFile = firstString(resolved.IdentityFile)
  return {
    ...(user ? { user } : {}),
    ...(port && Number.isFinite(port) ? { port } : {}),
    ...(hostName ? { hostName } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}

/** Read `~/.ssh/config` and return the list of connectable Host aliases.
 *  Returns `[]` if the file is missing or unreadable — the SSH tab in
 *  AddBackendModal still works via the "Custom host…" freeform input. */
export async function listConfiguredHosts(): Promise<ConfiguredHost[]> {
  const path = join(homedir(), '.ssh', 'config')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return parseSshConfigText(text)
}
