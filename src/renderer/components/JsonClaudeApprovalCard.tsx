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

/** Pull the "addRules" suggestions Claude attached to this approval
 *  request, normalised into PermissionUpdate shape. Returns [] when
 *  Claude didn't suggest anything (we fall back to a manual entry then). */
function extractSuggestions(raw: unknown[] | undefined): PermissionUpdate[] {
  if (!Array.isArray(raw)) return []
  const out: PermissionUpdate[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const obj = r as Record<string, unknown>
    if (obj['type'] !== 'addRules') continue
    const rules = Array.isArray(obj['rules']) ? obj['rules'] : []
    const cleanRules: Array<{ toolName: string; ruleContent?: string }> = []
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue
      const rObj = rule as Record<string, unknown>
      const toolName = typeof rObj['toolName'] === 'string' ? rObj['toolName'] : ''
      if (!toolName) continue
      const ruleContent =
        typeof rObj['ruleContent'] === 'string' ? rObj['ruleContent'] : undefined
      cleanRules.push(ruleContent ? { toolName, ruleContent } : { toolName })
    }
    if (cleanRules.length === 0) continue
    const behavior =
      obj['behavior'] === 'deny'
        ? 'deny'
        : obj['behavior'] === 'ask'
          ? 'ask'
          : 'allow'
    const destination =
      obj['destination'] === 'userSettings'
        ? 'userSettings'
        : obj['destination'] === 'projectSettings'
          ? 'projectSettings'
          : obj['destination'] === 'session'
            ? 'session'
            : 'localSettings'
    out.push({ type: 'addRules', rules: cleanRules, behavior, destination })
  }
  return out
}

/** Render a PermissionUpdate as the chip label `Tool(rule)` form the
 *  TUI uses. Multi-rule suggestions get joined by ` + `. */
function suggestionLabel(s: PermissionUpdate): string {
  return s.rules
    .map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
    .join(' + ')
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
  const suggestions = useMemo(
    () => extractSuggestions(approval.permissionSuggestions),
    [approval.permissionSuggestions]
  )
  // Pick the first suggestion by default — matches how the TUI
  // pre-highlights the most-likely "always allow" pattern.
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(0)
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
    // Submit the user's chosen suggestion (Claude generated it for this
    // specific tool call). Always force the destination to
    // localSettings — same behavior as Claude's TUI default. If Claude
    // didn't send any suggestions we don't expose the picker at all —
    // user falls back to the plain Allow / Allow with edits paths.
    const picked = suggestions[selectedSuggestionIdx]
    if (!picked) return
    onResolve({
      behavior: 'allow',
      updatedInput: approval.input,
      updatedPermissions: [{ ...picked, destination: 'localSettings' }]
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
          {approval.description && (
            <div className="text-[11px] text-muted italic">
              {approval.description}
            </div>
          )}
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
            {suggestions.length > 0 && (
              <button
                onClick={() => setMode('allowAlways')}
                className="px-2.5 py-1 text-xs rounded bg-success/10 hover:bg-success/20 text-success/80 transition-colors cursor-pointer"
                title="Allow this tool call and persist a rule so future similar calls auto-approve"
              >
                Allow always…
              </button>
            )}
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

      {mode === 'allowAlways' && suggestions.length > 0 && (
        <div className="px-3 py-2 space-y-2">
          <div className="text-[11px] text-muted">
            Pick a rule to persist into{' '}
            <code className="text-xs">.claude/settings.local.json</code>. Future
            tool calls matching the rule will auto-approve.
          </div>
          <div className="flex flex-col gap-1">
            {suggestions.map((s, i) => (
              <label
                key={i}
                className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer text-xs ${
                  selectedSuggestionIdx === i
                    ? 'border-success bg-success/10'
                    : 'border-border hover:bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="suggestion"
                  checked={selectedSuggestionIdx === i}
                  onChange={() => setSelectedSuggestionIdx(i)}
                />
                <code className="font-mono text-fg-bright truncate">
                  {suggestionLabel(s)}
                </code>
              </label>
            ))}
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
