import type { ContentBreakdown } from './state/costs'

export interface SessionCostSummary {
  sessionId: string
  projectPath: string
  totalCostUsd: number
  model: string | null
  firstAt: number
  lastAt: number
  turns: number
  breakdown: ContentBreakdown
}

export type SubscriptionTier = 'pro' | 'max-5x' | 'max-20x' | 'team' | 'enterprise' | 'unknown'

export interface ClaudeAuthInfo {
  loggedIn: boolean
  email: string | null
  organizationType: string | null
  rateLimitTier: string | null
  tier: SubscriptionTier | null
  monthlyUsd: number | null
}
