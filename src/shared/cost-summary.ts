export interface SessionCostSummary {
  sessionId: string
  projectPath: string
  totalCostUsd: number
  model: string | null
  firstAt: number
  lastAt: number
  turns: number
}
