import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EDIT_TOOL_NAMES,
  type JsonClaudePendingApproval
} from '../../shared/state/json-claude'
import { formatPendingTool } from '../pending-tool'
import { useJsonClaude, useSettings } from '../store'

interface JsonClaudeApprovalCardProps {
  approval: JsonClaudePendingApproval
  onResolve: (result: {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
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

export function JsonClaudeApprovalCard({
  approval,
  onResolve
}: JsonClaudeApprovalCardProps): JSX.Element {
  const settings = useSettings()
  const savedGuidance = settings.autoApproveSteerInstructions
  const [mode, setMode] = useState<'summary' | 'edit' | 'deny' | 'edit-guidance'>(
    'summary'
  )
  const [editedInput, setEditedInput] = useState<string>(() =>
    tryFormatInput(approval.input)
  )
  const [editError, setEditError] = useState<string | null>(null)
  const [denyMessage, setDenyMessage] = useState('user denied')
  const [interrupt, setInterrupt] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [guidanceDraft, setGuidanceDraft] = useState<string>(savedGuidance)
  // When the saved guidance changes externally (e.g. the user saved it in
  // Settings while this card was open), refresh the draft so the textarea
  // doesn't show stale text. We only re-sync when not actively editing
  // (mode !== 'edit-guidance') to avoid clobbering the user's typing.
  useEffect(() => {
    if (mode !== 'edit-guidance') setGuidanceDraft(savedGuidance)
  }, [savedGuidance, mode])
  const [guidanceSavedAt, setGuidanceSavedAt] = useState<number | null>(null)

  const summary = useMemo(
    () => formatPendingTool({ name: approval.toolName, input: approval.input }),
    [approval.toolName, approval.input]
  )

  const jsonClaude = useJsonClaude()
  const session = jsonClaude.sessions[approval.sessionId]
  const isEditTool = (EDIT_TOOL_NAMES as readonly string[]).includes(
    approval.toolName
  )
  const sessionGrantTools = isEditTool
    ? (EDIT_TOOL_NAMES as readonly string[])
    : [approval.toolName]
  const sessionGrantLabel = isEditTool
    ? 'Allow edits this session'
    : `Allow ${approval.toolName} this session`
  // Defensive: the bridge would have auto-resolved before we rendered
  // if the tool was already in the set, but keep the UI honest just in
  // case timing surprises us.
  const alreadyGranted =
    !!session &&
    sessionGrantTools.every((name) =>
      session.sessionToolApprovals.includes(name)
    )

  function allow(): void {
    // Claude Code 2.1.114's PermissionResult validator requires
    // updatedInput on the allow branch (it was optional in earlier
    // versions). Echo the original input back unchanged so plain Allow
    // is "allow with no changes".
    onResolve({ behavior: 'allow', updatedInput: approval.input })
  }

  async function allowThisSession(): Promise<void> {
    await window.api.grantJsonClaudeSessionToolApprovals(
      approval.sessionId,
      Array.from(sessionGrantTools)
    )
    onResolve({ behavior: 'allow', updatedInput: approval.input })
  }

  async function saveGuidance(): Promise<void> {
    await window.api.setAutoApproveSteerInstructions(guidanceDraft)
    setGuidanceSavedAt(Date.now())
  }

  async function saveGuidanceAndRerun(): Promise<void> {
    await window.api.setAutoApproveSteerInstructions(guidanceDraft)
    // Setting the saved timestamp before the IPC means the "Saved"
    // hint is briefly visible if re-review happens to be slow on the
    // first call. The card immediately re-renders with autoReview.state
    // back to 'pending' once main dispatches, replacing the static
    // "Auto-approver: …" row with the spinner.
    setGuidanceSavedAt(Date.now())
    await window.api.rerunJsonClaudeAutoApprovalReview(approval.requestId)
    setMode('summary')
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

  const autoReview = approval.autoReview

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

      {autoReview?.state === 'pending' && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b border-danger/20 bg-app/30 text-[11px] text-muted"
          title="An LLM reviewer is checking this tool call. You can still Allow or Deny manually — whichever happens first wins."
        >
          <span
            className="json-claude-spinner shrink-0"
            aria-label="auto-reviewing"
          />
          <span>Asking auto-approver…</span>
        </div>
      )}
      {autoReview?.state === 'finished' && autoReview.decision === 'ask' && (
        <div className="px-3 py-1.5 border-b border-danger/20 bg-app/30 text-[11px] text-muted flex items-center gap-2">
          <div
            className="flex-1 min-w-0"
            title={`The auto-approver deferred to a human: ${autoReview.reason ?? ''}`}
          >
            <span className="font-semibold mr-1">Auto-approver:</span>
            <span className="opacity-80">{autoReview.reason || 'deferred'}</span>
          </div>
          {mode !== 'edit-guidance' && (
            <button
              type="button"
              onClick={() => {
                setGuidanceDraft(savedGuidance)
                setGuidanceSavedAt(null)
                setMode('edit-guidance')
              }}
              className="text-[11px] px-2 py-0.5 rounded border border-border/60 bg-panel hover:bg-app/60 transition-colors shrink-0 cursor-pointer"
              title="Edit the steering guidance and optionally re-run the auto-approver on this request"
            >
              Edit guidance
            </button>
          )}
        </div>
      )}

      {mode === 'edit-guidance' && (
        <div className="px-3 py-2 space-y-2 bg-app/20 border-b border-danger/20">
          <div className="text-[11px] text-muted">
            Project-specific guidance appended to the auto-approver's policy.
            Save to persist for future requests; "Save & re-review" also re-runs
            the reviewer on this request right now.
          </div>
          <textarea
            value={guidanceDraft}
            onChange={(e) => setGuidanceDraft(e.target.value)}
            placeholder="e.g. Approve npm install. Deny any Bash that touches /etc."
            spellCheck={false}
            className="w-full bg-panel border border-border rounded p-2 text-[11px] font-mono outline-none focus:border-accent min-h-[80px] resize-y"
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => {
                void saveGuidanceAndRerun()
              }}
              className="px-2.5 py-1 text-xs rounded bg-success/20 hover:bg-success/30 text-success transition-colors cursor-pointer"
            >
              Save &amp; re-review
            </button>
            <button
              onClick={() => {
                void saveGuidance()
              }}
              disabled={guidanceDraft === savedGuidance}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save only
            </button>
            <button
              onClick={() => setMode('summary')}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            {guidanceSavedAt !== null && (
              <span className="text-[11px] text-success">Saved</span>
            )}
          </div>
        </div>
      )}

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
              Allow once
            </button>
            {!alreadyGranted && (
              <button
                onClick={() => {
                  void allowThisSession()
                }}
                title="Allow this tool for the rest of the session — future calls of this tool skip the prompt. Cleared when the app quits."
                className="px-3 py-1 text-xs font-semibold rounded bg-success/30 hover:bg-success/40 text-success border border-success/50 transition-colors cursor-pointer"
              >
                {sessionGrantLabel}
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
