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

export interface ModelOption {
  id: string
  displayName: string
  tier: 'current' | 'legacy'
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', tier: 'current' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'current' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'current' },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'legacy' },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1', tier: 'legacy' },
  { id: 'claude-sonnet-4-0', displayName: 'Claude Sonnet 4.0', tier: 'legacy' },
  { id: 'claude-opus-4-0', displayName: 'Claude Opus 4.0', tier: 'legacy' },
  { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', tier: 'legacy' },
  { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku', tier: 'legacy' },
  { id: 'claude-3-opus-latest', displayName: 'Claude 3 Opus', tier: 'legacy' }
]

export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', tier: 'current' },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', tier: 'current' },
  { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', tier: 'current' },
  { id: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', tier: 'current' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'current' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', tier: 'current' },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', tier: 'current' },
  { id: 'o3', displayName: 'o3', tier: 'legacy' },
  { id: 'o4-mini', displayName: 'o4-mini', tier: 'legacy' },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'legacy' },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', tier: 'legacy' },
]

export function getAgentInfo(kind: AgentKind): AgentInfo {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  if (!kind) return AGENT_REGISTRY[0].displayName
  return getAgentInfo(kind).displayName
}
