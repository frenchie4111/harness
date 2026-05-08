// Reads the user's Claude Code auth state from ~/.claude.json — the
// client-side mirror of the OAuth account info that `claude auth status`
// surfaces. Used by the Costs tab to show subscription-aware copy
// ("you're on Max 20x, this would have cost $X on the API").
//
// We deliberately avoid spawning `claude auth status` here:
//   1. Subprocess + login-shell wrap is slow on cold start.
//   2. ~/.claude.json carries the rate-limit-tier (5x vs 20x), which
//      `claude auth status`'s output doesn't break out.
//   3. No keychain access prompt — we never touch the credentials JSON
//      stored in the macOS keychain, only the local config mirror.

import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { ClaudeAuthInfo, SubscriptionTier } from '../shared/cost-summary'

export type { ClaudeAuthInfo, SubscriptionTier }

const TIER_PRICING: Record<SubscriptionTier, number | null> = {
  pro: 20,
  'max-5x': 100,
  'max-20x': 200,
  team: null,
  enterprise: null,
  unknown: null
}

let cached: ClaudeAuthInfo | null = null

export async function getClaudeAuthStatus(opts: { force?: boolean } = {}): Promise<ClaudeAuthInfo> {
  if (cached && !opts.force) return cached
  const fresh = await readAuthStatus()
  cached = fresh
  return fresh
}

async function readAuthStatus(): Promise<ClaudeAuthInfo> {
  const path = join(homedir(), '.claude.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return notLoggedIn()
  }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return notLoggedIn()
  }
  const oauth = obj.oauthAccount as Record<string, unknown> | undefined
  if (!oauth) return notLoggedIn()
  const orgType = typeof oauth.organizationType === 'string' ? oauth.organizationType : null
  const rateLimit =
    typeof oauth.organizationRateLimitTier === 'string'
      ? oauth.organizationRateLimitTier
      : null
  const email = typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null
  const tier = deriveTier(orgType, rateLimit)
  return {
    loggedIn: true,
    email,
    organizationType: orgType,
    rateLimitTier: rateLimit,
    tier,
    monthlyUsd: tier ? TIER_PRICING[tier] : null
  }
}

function deriveTier(
  orgType: string | null,
  rateLimitTier: string | null
): SubscriptionTier | null {
  if (!orgType) return null
  if (orgType === 'claude_pro') return 'pro'
  if (orgType === 'claude_max') {
    if (rateLimitTier?.includes('20x')) return 'max-20x'
    if (rateLimitTier?.includes('5x')) return 'max-5x'
    return 'unknown'
  }
  if (orgType === 'claude_team' || orgType.includes('team')) return 'team'
  if (orgType.includes('enterprise')) return 'enterprise'
  return 'unknown'
}

function notLoggedIn(): ClaudeAuthInfo {
  return {
    loggedIn: false,
    email: null,
    organizationType: null,
    rateLimitTier: null,
    tier: null,
    monthlyUsd: null
  }
}
