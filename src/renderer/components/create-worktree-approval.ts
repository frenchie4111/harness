export const CREATE_WORKTREE_TOOL_NAME =
  'mcp__harness-control__create_worktree'

export interface CreateWorktreeFormState {
  initialPrompt: string
  branchName: string
  agentKind: '' | 'claude' | 'codex'
  model: string
  baseBranch: string
}

export function readCreateWorktreeForm(
  input: Record<string, unknown>
): CreateWorktreeFormState {
  const agentKindRaw = typeof input.agentKind === 'string' ? input.agentKind : ''
  const agentKind: CreateWorktreeFormState['agentKind'] =
    agentKindRaw === 'claude' || agentKindRaw === 'codex' ? agentKindRaw : ''
  return {
    initialPrompt:
      typeof input.initialPrompt === 'string' ? input.initialPrompt : '',
    branchName: typeof input.branchName === 'string' ? input.branchName : '',
    agentKind,
    model: typeof input.model === 'string' ? input.model : '',
    baseBranch: typeof input.baseBranch === 'string' ? input.baseBranch : ''
  }
}

export function hasPrNumber(input: Record<string, unknown>): boolean {
  const v = input.prNumber
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

export function assembleCreateWorktreeInput(
  original: Record<string, unknown>,
  edited: CreateWorktreeFormState
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original }
  const pr = hasPrNumber(original)

  out.initialPrompt = edited.initialPrompt

  if (pr) {
    delete out.branchName
    delete out.baseBranch
  } else {
    const branch = edited.branchName.trim()
    if (branch) out.branchName = branch
    else delete out.branchName
    const base = edited.baseBranch.trim()
    if (base) out.baseBranch = base
    else delete out.baseBranch
  }

  if (edited.agentKind === 'claude' || edited.agentKind === 'codex') {
    out.agentKind = edited.agentKind
  } else {
    delete out.agentKind
  }

  const model = edited.model.trim()
  if (model) out.model = model
  else delete out.model

  return out
}
