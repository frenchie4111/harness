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
  }

  const allAnswered = questions.every((_, i) => (selections[i]?.length ?? 0) > 0)
  const canSubmit = canSubmitNow && questions.length > 0 && allAnswered

  function submit(): void {
    if (!canSubmit || !pendingApproval) return
    // The binary's input schema for AskUserQuestion accepts an optional
    // `answers: Record<string, string>` that the permission component is
    // expected to populate. Multi-select labels are joined with ", " per
    // the output schema's contract (read from the binary). Once we
    // resolve with this populated, claude's call() echoes the answers
    // straight into the tool_result text — no stdin-side wire format
    // for us to mimic.
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      const sel = selections[i] ?? []
      if (sel.length > 0) answers[q.question] = sel.join(', ')
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
