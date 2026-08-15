import { useMemo, useState } from 'react'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'
import {
  buildQuestionResult,
  parseQuestions,
  type QuestionAnswer
} from '../../shared/ask-user-question'
import { AskIcon } from './json-mode-cards/tool-icons'

interface JsonClaudeQuestionCardProps {
  approval: JsonClaudePendingApproval
  onResolve: (result: {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    message?: string
  }) => void
}

const EMPTY_ANSWER: QuestionAnswer = { selected: [], custom: '' }

export function JsonClaudeQuestionCard({
  approval,
  onResolve
}: JsonClaudeQuestionCardProps): JSX.Element {
  const questions = useMemo(() => parseQuestions(approval.input), [approval.input])
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')

  const answeredCount = questions.filter((q) => {
    const a = answers[q.question]
    return a && (a.selected.length > 0 || a.custom.trim() !== '')
  }).length

  function update(question: string, patch: Partial<QuestionAnswer>): void {
    setAnswers((prev) => ({
      ...prev,
      [question]: { ...EMPTY_ANSWER, ...prev[question], ...patch }
    }))
  }

  function toggle(question: string, label: string, multi: boolean): void {
    const current = answers[question]?.selected ?? []
    const next = multi
      ? current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
      : [label]
    // Picking an option clears any "Other" text — the two are alternatives,
    // and a stale custom string would silently win over the click.
    update(question, { selected: next, custom: '' })
  }

  function submit(): void {
    onResolve(buildQuestionResult(approval.input, questions, answers))
  }

  function sendReply(): void {
    onResolve(buildQuestionResult(approval.input, questions, answers, reply))
  }

  function skip(): void {
    onResolve(buildQuestionResult(approval.input, questions, {}))
  }

  // Malformed input would otherwise render an empty shell with no way to
  // unblock the turn, leaving the model waiting on a socket forever.
  if (questions.length === 0) {
    return (
      <div className="rounded-md border border-border bg-panel my-2 px-3 py-2 space-y-2">
        <div className="text-xs text-muted">
          Claude asked a question, but the payload couldn't be read.
        </div>
        <button
          onClick={() => onResolve({ behavior: 'deny', message: 'malformed question' })}
          className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    )
  }

  return (
    <div
      id={approval.requestId}
      className="rounded-md border border-accent/40 bg-accent/5 my-2 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/30 bg-accent/10">
        <AskIcon className="icon-sm shrink-0 text-accent" />
        <span className="text-xs font-semibold uppercase tracking-wide text-accent">
          {questions.length > 1 ? `${questions.length} questions` : 'Question'}
        </span>
      </div>

      <div className="px-3 py-2 space-y-4">
        {questions.map((q) => {
          const answer = answers[q.question] ?? EMPTY_ANSWER
          const multi = q.multiSelect === true
          return (
            <div key={q.question} className="space-y-1.5">
              {q.header && (
                <div className="text-xs uppercase tracking-wide text-muted">
                  {q.header}
                </div>
              )}
              <div className="text-sm text-fg-bright">{q.question}</div>
              <div className="space-y-1">
                {q.options.map((opt) => {
                  const checked = answer.selected.includes(opt.label)
                  return (
                    <label
                      key={opt.label}
                      className="flex items-start gap-2 px-2 py-1 rounded hover:bg-app/40 cursor-pointer"
                    >
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={`q-${approval.requestId}-${q.question}`}
                        checked={checked}
                        onChange={() => toggle(q.question, opt.label, multi)}
                        className="icon-base mt-0.5 shrink-0 cursor-pointer"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-xs text-fg-bright">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-xs text-muted">
                            {opt.description}
                          </span>
                        )}
                        {opt.preview && (
                          <pre className="mt-1 text-xs font-mono bg-app/40 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">
                            {opt.preview}
                          </pre>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
              <input
                type="text"
                value={answer.custom}
                onChange={(e) =>
                  update(q.question, { custom: e.target.value, selected: [] })
                }
                placeholder="Other…"
                className="w-full bg-app/40 border border-border rounded px-2 py-1 text-xs outline-none focus:border-accent"
              />
            </div>
          )
        })}
      </div>

      {replying && (
        <div className="px-3 pb-2 space-y-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to Claude instead of picking an option…"
            autoFocus
            className="w-full bg-app/40 border border-border rounded p-2 text-xs outline-none focus:border-accent min-h-[60px] resize-y"
          />
        </div>
      )}

      <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
        {replying ? (
          <>
            <button
              onClick={sendReply}
              disabled={!reply.trim()}
              className="px-2.5 py-1 text-xs rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send reply
            </button>
            <button
              onClick={() => setReplying(false)}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Back
            </button>
          </>
        ) : (
          <>
            <button
              onClick={submit}
              disabled={answeredCount === 0}
              className="px-3 py-1 text-xs font-semibold rounded bg-accent/30 hover:bg-accent/40 text-accent border border-accent/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {questions.length > 1 && answeredCount < questions.length
                ? `Submit ${answeredCount} of ${questions.length}`
                : 'Submit'}
            </button>
            <button
              onClick={() => setReplying(true)}
              title="Answer in your own words instead of choosing an option"
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Reply instead
            </button>
            <button
              onClick={skip}
              title="Continue without answering — Claude decides for itself"
              className="px-2.5 py-1 text-xs rounded text-muted hover:text-fg hover:bg-surface/60 transition-colors cursor-pointer"
            >
              Skip
            </button>
          </>
        )}
      </div>
    </div>
  )
}
