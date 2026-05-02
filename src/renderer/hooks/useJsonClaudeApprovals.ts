import { useCallback, useMemo } from 'react'
import { useJsonClaudePendingApprovals } from '../store'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
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
  const pendingApprovals = useJsonClaudePendingApprovals()
  const pending = useMemo(() => {
    const list = Object.values(pendingApprovals).filter(
      (a) => a.sessionId === sessionId
    )
    list.sort((a, b) => a.timestamp - b.timestamp)
    return list
  }, [pendingApprovals, sessionId])

  const resolve = useCallback((requestId: string, result: ApprovalResult) => {
    void window.api.resolveJsonClaudeApproval(requestId, result)
  }, [])

  return { pending, resolve }
}
