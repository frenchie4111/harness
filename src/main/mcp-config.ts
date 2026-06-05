// Legacy cleanup helper. Harness used to write per-terminal MCP configs
// into userData/mcp-configs/ and pass them via --mcp-config; now the
// bundled Harness plugin (resources/plugins/harness-status/.mcp.json,
// loaded by --plugin-dir) carries the same config and interpolates
// per-spawn env vars at launch time. This function sweeps any stale
// files left over from the prior layout. Safe to remove once all
// upgraded users have booted at least once.

import { existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Remove mcp config files for terminals not present in `keepIds`.
 *  Since Harness no longer writes new files here, the practical effect
 *  is "drain the legacy dir as worktrees churn." */
export function pruneMcpConfigs(keepIds: Set<string>): void {
  try {
    const dir = join(userDataDir(), 'mcp-configs')
    if (!existsSync(dir)) return
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitize(id)}.json`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try {
          unlinkSync(join(dir, file))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
