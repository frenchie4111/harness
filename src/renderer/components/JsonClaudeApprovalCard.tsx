import { useMemo, useRef, useState } from 'react'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'
import { formatPendingTool } from '../pending-tool'

// Mirrors the schema Claude Code's --permission-prompt-tool validator
// expects on PermissionResult.updatedPermissions. Returning an addRules
// entry persists a permission rule into the destination scope, same way
// the TUI's "always allow" affordance does.
type RuleDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
type PermissionUpdate = {
  type: 'addRules'
  rules: Array<{ toolName: string; ruleContent?: string }>
  behavior: 'allow' | 'deny' | 'ask'
  destination: RuleDestination
}

interface JsonClaudeApprovalCardProps {
  approval: JsonClaudePendingApproval
  onResolve: (result: {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    updatedPermissions?: PermissionUpdate[]
    message?: string
    interrupt?: boolean
  }) => void
}

function tryFormatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** Best-effort default rule pattern for "always allow" — what would the
 *  user most likely want to whitelist for this specific tool call?
 *  Bash gets the first verb-ish prefix (`npm test ...` → `npm test:*`),
 *  matching how the TUI's quick-allow generates rules. Other tools fall
 *  back to a bare toolName, meaning "always allow this tool wholesale". */
function defaultRulePattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(input['command'] ?? '').trim()
    if (!cmd) return ''
    // First two whitespace-delimited tokens, e.g. `git push` from
    // `git push origin main`. Single-token commands (`make`) use just
    // the one token. Suffix `:*` so subsequent args don't matter.
    const tokens = cmd.split(/\s+/).filter(Boolean)
    const head = tokens.slice(0, tokens[0] === 'git' ? 2 : 1).join(' ')
    return `${head}:*`
  }
  return ''
}

export function JsonClaudeApprovalCard({
  approval,
  onResolve
}: JsonClaudeApprovalCardProps): JSX.Element {
  const [mode, setMode] = useState<'summary' | 'edit' | 'deny' | 'allowAlways'>(
    'summary'
  )
  const [editedInput, setEditedInput] = useState<string>(() =>
    tryFormatInput(approval.input)
  )
  const [editError, setEditError] = useState<string | null>(null)
  const [denyMessage, setDenyMessage] = useState('user denied')
  const [interrupt, setInterrupt] = useState(false)
  const [rulePattern, setRulePattern] = useState<string>(() =>
    defaultRulePattern(approval.toolName, approval.input)
  )
  const [ruleDestination, setRuleDestination] =
    useState<RuleDestination>('localSettings')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const summary = useMemo(
    () => formatPendingTool({ name: approval.toolName, input: approval.input }),
    [approval.toolName, approval.input]
  )

  function allow(): void {
    // Claude Code 2.1.114's PermissionResult validator requires
    // updatedInput on the allow branch (it was optional in earlier
    // versions). Echo the original input back unchanged so plain Allow
    // is "allow with no changes".
    onResolve({ behavior: 'allow', updatedInput: approval.input })
  }

  function allowWithEdits(): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(editedInput) as Record<string, unknown>
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
      return
    }
    setEditError(null)
    onResolve({ behavior: 'allow', updatedInput: parsed })
  }

  function deny(): void {
    onResolve({
      behavior: 'deny',
      message: denyMessage.trim() || 'user denied',
      interrupt
    })
  }

  function allowAlways(): void {
    // Persist the rule into the destination scope alongside this allow.
    // Empty ruleContent means "all calls to this tool" — useful for
    // tools where pattern-matching the input doesn't make sense.
    const trimmed = rulePattern.trim()
    const rule = {
      toolName: approval.toolName,
      ...(trimmed ? { ruleContent: trimmed } : {})
    }
    onResolve({
      behavior: 'allow',
      updatedInput: approval.input,
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [rule],
          behavior: 'allow',
          destination: ruleDestination
        }
      ]
    })
  }

  return (
    <div className="rounded-md border border-danger/40 bg-danger/5 my-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-danger/30 bg-danger/10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wide text-danger shrink-0">
            Needs approval
          </span>
          <span className="text-xs font-mono text-fg-bright truncate">{summary}</span>
        </div>
      </div>

      {mode === 'summary' && (
        <div className="px-3 py-2 space-y-2">
          <pre className="text-[11px] font-mono bg-app/40 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">
            {tryFormatInput(approval.input)}
          </pre>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={allow}
              className="px-2.5 py-1 text-xs rounded bg-success/20 hover:bg-success/30 text-success transition-colors cursor-pointer"
            >
              Allow
            </button>
            <button
              onClick={() => setMode('allowAlways')}
              className="px-2.5 py-1 text-xs rounded bg-success/10 hover:bg-success/20 text-success/80 transition-colors cursor-pointer"
              title="Allow this tool call and persist a rule so future similar calls auto-approve"
            >
              Allow always…
            </button>
            <button
              onClick={() => setMode('edit')}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Allow with edits
            </button>
            <button
              onClick={() => setMode('deny')}
              className="px-2.5 py-1 text-xs rounded bg-danger/20 hover:bg-danger/30 text-danger transition-colors cursor-pointer"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {mode === 'allowAlways' && (
        <div className="px-3 py-2 space-y-2">
          <div className="text-[11px] text-muted">
            Persist a permission rule so similar future tool calls auto-approve
            without prompting. Same shape Claude's TUI writes to{' '}
            <code className="text-xs">.claude/settings.local.json</code>.
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted">
              {approval.toolName}(
            </span>
            <input
              type="text"
              value={rulePattern}
              onChange={(e) => setRulePattern(e.target.value)}
              placeholder="leave blank to match all calls"
              className="flex-1 bg-app/40 border border-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-accent"
            />
            <span className="text-xs font-mono text-muted">)</span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted">Destination:</span>
            <select
              value={ruleDestination}
              onChange={(e) => setRuleDestination(e.target.value as RuleDestination)}
              className="bg-app/40 border border-border rounded px-2 py-0.5 text-xs outline-none focus:border-accent"
            >
              <option value="localSettings">.claude/settings.local.json</option>
              <option value="projectSettings">.claude/settings.json</option>
              <option value="userSettings">~/.claude/settings.json</option>
              <option value="session">this session only</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={allowAlways}
              className="px-2.5 py-1 text-xs rounded bg-success/20 hover:bg-success/30 text-success transition-colors cursor-pointer"
            >
              Allow + remember
            </button>
            <button
              onClick={() => setMode('summary')}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="px-3 py-2 space-y-2">
          <div className="text-[11px] text-muted">
            Edit the tool input JSON before running.
          </div>
          <textarea
            ref={textareaRef}
            value={editedInput}
            onChange={(e) => {
              setEditedInput(e.target.value)
              if (editError) setEditError(null)
            }}
            className="w-full bg-app/40 border border-border rounded p-2 text-[11px] font-mono outline-none focus:border-accent min-h-[120px]"
            spellCheck={false}
          />
          {editError && (
            <div className="text-[11px] text-danger">Invalid JSON: {editError}</div>
          )}
          <div className="flex items-center gap-1.5">
            <button
              onClick={allowWithEdits}
              className="px-2.5 py-1 text-xs rounded bg-success/20 hover:bg-success/30 text-success transition-colors cursor-pointer"
            >
              Allow edited
            </button>
            <button
              onClick={() => setMode('summary')}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'deny' && (
        <div className="px-3 py-2 space-y-2">
          <textarea
            value={denyMessage}
            onChange={(e) => setDenyMessage(e.target.value)}
            placeholder="Reason shown to Claude (optional)"
            className="w-full bg-app/40 border border-border rounded p-2 text-xs outline-none focus:border-danger min-h-[60px] resize-none"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={interrupt}
              onChange={(e) => setInterrupt(e.target.checked)}
            />
            Interrupt turn (abort the model's current response)
          </label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={deny}
              className="px-2.5 py-1 text-xs rounded bg-danger/20 hover:bg-danger/30 text-danger transition-colors cursor-pointer"
            >
              Deny
            </button>
            <button
              onClick={() => setMode('summary')}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
