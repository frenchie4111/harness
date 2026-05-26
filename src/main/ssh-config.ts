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
import SSHConfig, { LineType, type Line } from 'ssh-config'

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
  let parsed: SSHConfig
  try {
    parsed = SSHConfig.parse(text)
  } catch {
    return []
  }

  const hosts: ConfiguredHost[] = []
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
