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
  installHooks(worktreePath: string): void
  hooksInstalled(worktreePath: string): boolean
  sessionFileExists(cwd: string, sessionId: string): boolean
  latestSessionId(cwd: string): string | null
}

const agents: Record<AgentKind, AgentModule> = { claude, codex }

export function getAgent(kind: AgentKind): AgentModule {
  return agents[kind]
}
