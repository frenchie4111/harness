// AskUserQuestion is one of claude's built-in client-handled tools. The
// model uses it to pose multiple-choice questions instead of guessing —
// "OAuth or JWT for the auth flow?". Schema (verified against the
// bundled @anthropic-ai/claude-code binary's Zod definition):
//   { questions: Array<{ question: string, header: string,
//                        options: Array<{ label: string,
//                                         description: string,
//                                         preview?: string }>,
//                        multiSelect: boolean }> }
//
// Wire-format note: the binary marks AskUserQuestion with checkPermissions=ask
// so claude routes through --permission-prompt-tool. We DON'T auto-allow
// here — instead we hold the request as a normal pendingApproval and let
// the user pick options inline. On submit we resolve the approval with
// `updatedInput.answers` populated (Record<question text, label string>;
// multi-select labels comma-separated, per the binary's output schema).
// Claude's call() then runs with answers in scope and produces the
// canonical tool_result text via mapToolResultToToolResultBlockParam,
// so we never have to mimic that format ourselves.

import { useMemo, useState } from 'react'
import { ToolCardChrome, type ToolCardProps } from './index'
import type { JsonClaudePendingApproval } from '../../../shared/state/json-claude'

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export function extractQuestions(
  input: Record<string, unknown> | undefined
): Question[] {
  const raw = input?.['questions']
  if (!Array.isArray(raw)) return []
  return raw
    .map((q: unknown): Question | null => {
      if (!q || typeof q !== 'object') return null
      const obj = q as Record<string, unknown>
      const question = typeof obj['question'] === 'string' ? obj['question'] : ''
      const header = typeof obj['header'] === 'string' ? obj['header'] : ''
      const multiSelect = obj['multiSelect'] === true
      const optsRaw = obj['options']
      if (!question || !Array.isArray(optsRaw)) return null
      const options = optsRaw
        .map((o: unknown): QuestionOption | null => {
          if (!o || typeof o !== 'object') return null
          const oo = o as Record<string, unknown>
          const label = typeof oo['label'] === 'string' ? oo['label'] : ''
          if (!label) return null
          return {
            label,
            description:
              typeof oo['description'] === 'string' ? oo['description'] : undefined,
            preview: typeof oo['preview'] === 'string' ? oo['preview'] : undefined
          }
        })
        .filter((o): o is QuestionOption => o !== null)
      return { question, header, options, multiSelect }
    })
    .filter((q): q is Question => q !== null)
}

interface AskUserQuestionCardProps extends ToolCardProps {
  pendingApproval?: JsonClaudePendingApproval
}

export function AskUserQuestionCard({
  block,
  result,
  pendingApproval
}: AskUserQuestionCardProps): JSX.Element {
  const questions = useMemo(() => extractQuestions(block.input), [block.input])
  // The card has three states:
  //   1. pendingApproval set, no result yet → show interactive form
  //   2. result set → show "Answered" summary (post-submit or post-resume)
  //   3. neither → show a static "waiting" message (rare race)
  const isAnswered = !!result
  const canSubmitNow = !isAnswered && !!pendingApproval
  const [selections, setSelections] = useState<string[][]>(() =>
    questions.map(() => [])
  )
  // The binary's tool prompt promises every AskUserQuestion gets a
  // synthetic "Other" choice that lets the user type free-form text.
  // The prompt also forbids Claude from including its own "Other" in
  // the predefined options, so we own this entirely on the client side.
  // Tracked as a parallel { otherChecked, otherText } per question
  // rather than mixed into `selections` so submit/render logic stays
  // simple — selections are just the labels Claude offered.
  const [otherChecked, setOtherChecked] = useState<boolean[]>(() =>
    questions.map(() => false)
  )
  const [otherText, setOtherText] = useState<string[]>(() =>
    questions.map(() => '')
  )

  const headerLabel =
    questions[0]?.header || (questions.length > 0 ? 'Question' : 'Question')
  const subtitle = isAnswered
    ? 'answered'
    : questions[0]?.question
      ? truncate(questions[0].question, 80)
      : `${questions.length} question${questions.length === 1 ? '' : 's'}`

  function toggle(qIdx: number, label: string, multi: boolean): void {
    setSelections((prev) =>
      prev.map((s, i) => {
        if (i !== qIdx) return s
        if (!multi) return [label]
        return s.includes(label) ? s.filter((l) => l !== label) : [...s, label]
      })
    )
    if (!multi) {
      // Single-select: picking a real option clears Other.
      setOtherChecked((prev) => prev.map((v, i) => (i === qIdx ? false : v)))
    }
  }

  function toggleOther(qIdx: number, multi: boolean): void {
    setOtherChecked((prev) => {
      const willBeChecked = !prev[qIdx]
      if (!multi && willBeChecked) {
        // Single-select: turning Other on clears any picked label.
        setSelections((sel) => sel.map((s, i) => (i === qIdx ? [] : s)))
      }
      return prev.map((v, i) => (i === qIdx ? willBeChecked : v))
    })
  }

  function questionAnswered(i: number): boolean {
    const labelCount = selections[i]?.length ?? 0
    if (labelCount > 0) return true
    if (otherChecked[i]) return otherText[i].trim().length > 0
    return false
  }

  const canSubmit =
    canSubmitNow &&
    questions.length > 0 &&
    questions.every((_, i) => questionAnswered(i))

  function submit(): void {
    if (!canSubmit || !pendingApproval) return
    // The binary's input schema for AskUserQuestion accepts an optional
    // `answers: Record<string, string>` that the permission component is
    // expected to populate. Multi-select labels are joined with ", " per
    // the output schema's contract (read from the binary). Custom Other
    // text is appended into the same comma-joined string — claude reads
    // the answer as plain text either way. Once we resolve with this
    // populated, claude's call() echoes the answers straight into the
    // tool_result text — no stdin-side wire format for us to mimic.
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      const parts: string[] = [...(selections[i] ?? [])]
      if (otherChecked[i]) {
        const t = otherText[i].trim()
        if (t.length > 0) parts.push(t)
      }
      if (parts.length > 0) answers[q.question] = parts.join(', ')
    })
    void window.api.resolveJsonClaudeApproval(pendingApproval.requestId, {
      behavior: 'allow',
      updatedInput: { ...pendingApproval.input, answers }
    })
  }

  return (
    <ToolCardChrome
      name={`Question · ${headerLabel}`}
      subtitle={subtitle}
      variant="info"
      defaultExpanded={!isAnswered}
    >
      <div className="px-3 py-2 space-y-3 text-xs">
        {questions.map((q, qIdx) => (
          <div key={qIdx} className="space-y-1.5">
            <div className="text-fg/90 font-medium">{q.question}</div>
            {q.multiSelect && !isAnswered && (
              <div className="text-faint italic text-[10px]">
                Select one or more
              </div>
            )}
            <div className="space-y-1">
              {q.options.map((opt, oIdx) => {
                const selected = (selections[qIdx] ?? []).includes(opt.label)
                const inputId = `auq-${block.id}-${qIdx}-${oIdx}`
                return (
                  <label
                    key={oIdx}
                    htmlFor={inputId}
                    className={`flex items-start gap-2 px-2 py-1.5 border ${
                      selected
                        ? 'border-accent/60 bg-accent/10'
                        : 'border-border bg-app/30'
                    } rounded ${isAnswered ? 'opacity-60' : 'cursor-pointer hover:bg-app/60'}`}
                  >
                    <input
                      id={inputId}
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`auq-${block.id}-${qIdx}`}
                      checked={selected}
                      disabled={isAnswered}
                      onChange={() => toggle(qIdx, opt.label, q.multiSelect)}
                      className="mt-0.5 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-fg/95">{opt.label}</div>
                      {opt.description && (
                        <div className="text-muted text-[11px] mt-0.5">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  </label>
                )
              })}
              {!isAnswered && (
                <OtherOption
                  blockId={block.id}
                  qIdx={qIdx}
                  multi={q.multiSelect}
                  checked={otherChecked[qIdx] ?? false}
                  text={otherText[qIdx] ?? ''}
                  onToggle={() => toggleOther(qIdx, q.multiSelect)}
                  onTextChange={(t) =>
                    setOtherText((prev) =>
                      prev.map((v, i) => (i === qIdx ? t : v))
                    )
                  }
                  onSubmit={submit}
                />
              )}
            </div>
          </div>
        ))}
        {isAnswered ? (
          <AnsweredSummary content={result?.content ?? ''} />
        ) : (
          <div className="flex items-center justify-end pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className={`text-xs px-3 py-1 rounded border ${
                canSubmit
                  ? 'border-accent/60 bg-accent/15 hover:bg-accent/25 text-accent cursor-pointer'
                  : 'border-border bg-app/30 text-faint cursor-not-allowed'
              }`}
            >
              Submit answer
            </button>
          </div>
        )}
      </div>
    </ToolCardChrome>
  )
}

function OtherOption({
  blockId,
  qIdx,
  multi,
  checked,
  text,
  onToggle,
  onTextChange,
  onSubmit
}: {
  blockId: string | undefined
  qIdx: number
  multi: boolean
  checked: boolean
  text: string
  onToggle: () => void
  onTextChange: (t: string) => void
  onSubmit: () => void
}): JSX.Element {
  const inputId = `auq-${blockId}-${qIdx}-other`
  const textInputId = `auq-${blockId}-${qIdx}-other-text`
  return (
    <div
      className={`border ${
        checked ? 'border-accent/60 bg-accent/10' : 'border-border bg-app/30'
      } rounded`}
    >
      <label
        htmlFor={inputId}
        className="flex items-start gap-2 px-2 py-1.5 cursor-pointer hover:bg-app/60"
      >
        <input
          id={inputId}
          type={multi ? 'checkbox' : 'radio'}
          name={`auq-${blockId}-${qIdx}`}
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-fg/95 italic">Other</div>
          <div className="text-muted text-[11px] mt-0.5">
            Type your own answer
          </div>
        </div>
      </label>
      {checked && (
        <div className="px-2 pb-2">
          <input
            id={textInputId}
            type="text"
            autoFocus
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSubmit()
              }
            }}
            placeholder="Your answer…"
            className="w-full text-xs px-2 py-1 bg-app border border-border/70 rounded focus:outline-none focus:border-accent/60"
          />
        </div>
      )}
    </div>
  )
}

function AnsweredSummary({ content }: { content: string }): JSX.Element {
  const trimmed = content.trim()
  return (
    <div className="text-[11px] text-muted border-t border-border/60 pt-2">
      <div className="font-semibold text-fg/80 mb-1">Answered</div>
      <pre className="whitespace-pre-wrap font-mono opacity-80">{trimmed}</pre>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
