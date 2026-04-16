import type { AgentKind } from './state/terminals'

export interface AgentInfo {
  kind: AgentKind
  displayName: string
  vendor: string
}

export const AGENT_REGISTRY: AgentInfo[] = [
  { kind: 'claude', displayName: 'Claude Code', vendor: 'Anthropic' },
  { kind: 'codex', displayName: 'Codex', vendor: 'OpenAI' }
]

export function getAgentInfo(kind: AgentKind): AgentInfo {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  if (!kind) return AGENT_REGISTRY[0].displayName
  return getAgentInfo(kind).displayName
}
