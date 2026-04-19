import { useCallback, useMemo } from 'react'
import { useJsonClaude } from '../store'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}

interface UseApprovals {
  /** Pending approvals for this session in request-time order. */
  pending: JsonClaudePendingApproval[]
  /** Resolve an approval by request id. */
  resolve: (requestId: string, result: ApprovalResult) => void
}

export function useJsonClaudeApprovals(sessionId: string): UseApprovals {
  const state = useJsonClaude()
  const pending = useMemo(() => {
    const list = Object.values(state.pendingApprovals).filter(
      (a) => a.sessionId === sessionId
    )
    list.sort((a, b) => a.timestamp - b.timestamp)
    return list
  }, [state.pendingApprovals, sessionId])

  const resolve = useCallback((requestId: string, result: ApprovalResult) => {
    void window.api.resolveJsonClaudeApproval(requestId, result)
  }, [])

  return { pending, resolve }
}
