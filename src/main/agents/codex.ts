import { join } from 'path'
import { homedir } from 'os'
import { readdirSync, statSync } from 'fs'
import { stripHarnessEntriesFromHooksFile, legacyWorktreeHooksPath } from '../codex-plugin'
import type { AgentSpawnOpts } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export const defaultCommand = 'codex'
export const assignsSessionId = false

// Codex's hook event names — used by AgentModule for parity with
// Claude's. Codex hooks now ship inside the bundled plugin (see
// resources/plugins/harness-status/hooks/hooks.json), so this list
// exists only to satisfy the interface; nothing in the install path
// reads it anymore.
export const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop'
]

/** Legacy one-shot strip — removes Harness entries from a worktree's
 *  .codex/hooks.json (the old install location, pre-plugin). Boot-time
 *  migration sweeps this for every worktree; the AgentModule contract
 *  also exposes it for the panes FSM's per-worktree initialization
 *  callback. After migration completes, both paths become no-ops. */
export function stripHooksFromWorktree(worktreePath: string): boolean {
  return stripHarnessEntriesFromHooksFile(legacyWorktreeHooksPath(worktreePath))
}

export function sessionFileExists(_cwd: string, sessionId: string): boolean {
  try {
    const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
    const walkDir = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (walkDir(join(dir, entry.name))) return true
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return true
        }
      }
      return false
    }
    return walkDir(sessionsDir)
  } catch {
    return false
  }
}

export function latestSessionId(_cwd: string): string | null {
  try {
    const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
    let bestId: string | null = null
    let bestMtime = -Infinity
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(full)
        } else if (entry.name.endsWith('.jsonl')) {
          const mtime = statSync(full).mtimeMs
          if (mtime > bestMtime) {
            bestMtime = mtime
            const stem = entry.name.replace(/\.jsonl$/, '')
            const uuidMatch = stem.match(/([0-9a-f]{4,}-[0-9a-f-]+)$/)
            bestId = uuidMatch ? uuidMatch[1] : stem
          }
        }
      }
    }
    walkDir(sessionsDir)
    return bestId
  } catch {
    return null
  }
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // The bundled plugin's static .mcp.json uses `${HARNESS_NODE_EXEC}`
  // and friends, which Codex does NOT interpolate (verified against
  // 0.133: Codex passes the literal templates to execve and strips
  // most of the inherited env when spawning MCP subprocesses).
  // codex-plugin.ts:neutralizeCachedMcpJson erases the harness-control
  // entry from Codex's cached plugin copy so it doesn't try to spawn
  // a process named `${HARNESS_NODE_EXEC}` and fail with ENOENT;
  // instead we register the MCP server per-spawn via `-c` overrides
  // with all values as literals.
  //
  // Plugin hooks require interactive trust before they fire — Codex
  // shows a TUI "Hooks need review / Trust all and continue" prompt
  // on first launch after a new/changed plugin install, then
  // persists per-event trust hashes in ~/.codex/config.toml under
  // [hooks.state]. There's no CLI flag or subcommand to drive this
  // non-interactively. The Settings card surfaces guidance when the
  // verification probe detects untrusted hooks.
  let cmd = opts.command

  if (opts.harnessControl) {
    const hc = opts.harnessControl
    // -c values must be valid TOML; strings need embedded quotes.
    cmd += ` -c ${shellQuote(`mcp_servers.harness-control.command=${JSON.stringify(hc.execPath)}`)}`
    cmd += ` -c ${shellQuote(`mcp_servers.harness-control.args=${JSON.stringify([hc.bridgePath])}`)}`
    const envEntries = [
      `ELECTRON_RUN_AS_NODE="1"`,
      `HARNESS_PORT=${JSON.stringify(String(hc.port))}`,
      `HARNESS_TOKEN=${JSON.stringify(hc.token)}`,
      `HARNESS_TERMINAL_ID=${JSON.stringify(hc.terminalId)}`,
      `HARNESS_SESSION_ID=${JSON.stringify(hc.terminalId)}`
    ]
    if (hc.workspaceId) envEntries.push(`HARNESS_WORKTREE_ID=${JSON.stringify(hc.workspaceId)}`)
    if (hc.repoRoot) envEntries.push(`HARNESS_REPO_ROOT=${JSON.stringify(hc.repoRoot)}`)
    if (hc.isMain) envEntries.push(`HARNESS_IS_MAIN="1"`)
    cmd += ` -c ${shellQuote(`mcp_servers.harness-control.env={${envEntries.join(',')}}`)}`
  }

  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}
