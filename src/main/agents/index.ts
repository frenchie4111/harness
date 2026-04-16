import type { AgentKind } from '../../shared/state/terminals'
import * as claude from './claude'
import * as codex from './codex'

export type { AgentKind }

export interface AgentSpawnOpts {
  command: string
  cwd: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  sessionName?: string
  mcpConfigPath?: string | null
}

export interface AgentModule {
  hookEvents: string[]
  defaultCommand: string
  /** If true, Harness generates the session ID and passes it to the agent
   * CLI on first spawn (e.g. Claude's --session-id). If false, the agent
   * assigns its own ID and Harness discovers it from the first hook event. */
  assignsSessionId: boolean
  /** Install status hooks at the agent's user-scope settings file
   *  (~/.claude/settings.json for Claude, ~/.codex/hooks.json for Codex).
   *  The hook command is gated on $HARNESS_TERMINAL_ID so sessions spawned
   *  outside Harness are untouched. */
  installHooks(): void
  hooksInstalled(): boolean
  /** Remove only the Harness-marked entries from the user-scope settings file.
   *  Any user-authored hooks and unrelated keys survive. */
  uninstallHooks(): void
  /** Migration: strip legacy Harness entries from a single worktree's
   *  per-worktree settings file. Returns true if the file was modified. */
  stripHooksFromWorktree(worktreePath: string): boolean
  sessionFileExists(cwd: string, sessionId: string): boolean
  latestSessionId(cwd: string): string | null
  buildSpawnArgs(opts: AgentSpawnOpts): string
}

const agents: Record<AgentKind, AgentModule> = { claude, codex }

export function getAgent(kind: AgentKind): AgentModule {
  return agents[kind]
}
