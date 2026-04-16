import type { AgentKind } from './state/terminals'

export interface AgentInfo {
  kind: AgentKind
  displayName: string
  vendor: string
  /** If true, Harness generates a session ID and passes it to the CLI on
   * first spawn. If false, the agent assigns its own ID and Harness
   * discovers it from the first hook event. */
  assignsSessionId: boolean
}

export const AGENT_REGISTRY: AgentInfo[] = [
  { kind: 'claude', displayName: 'Claude Code', vendor: 'Anthropic', assignsSessionId: true },
  { kind: 'codex', displayName: 'Codex', vendor: 'OpenAI', assignsSessionId: false }
]

export function getAgentInfo(kind: AgentKind): AgentInfo {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  if (!kind) return AGENT_REGISTRY[0].displayName
  return getAgentInfo(kind).displayName
}
