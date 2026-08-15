// Payload shapes for the AskUserQuestion tool.
//
// The tool reaches Harness through the permission bridge like any other
// tool call, but the approval response is also the answer channel: the
// bundled claude binary's tool implementation reads `answers` and
// `annotations` off its own input, and the only thing that can modify
// that input between the model emitting it and the tool running is
// `updatedInput` on the PermissionResult. So answering the question and
// approving the tool call are the same round trip.
//
// Wire shape, mirrored from the binary's TUI submit path:
//   {
//     behavior: 'allow',
//     updatedInput: {
//       ...originalInput,
//       answers:     { [questionText]: 'Option label' },
//       annotations: { [questionText]: { preview?, notes? } },
//       response?:   'free-text reply to the whole call'
//     }
//   }
//
// Encoding rules the binary enforces when it renders the tool result:
//   * multiSelect answers are a single ", "-joined string, not an array.
//   * an omitted question reads as "(no option selected)".
//   * a `response` string short-circuits the per-question answers and
//     surfaces as "The user responded: …".
// These are undocumented and could drift across claude-code releases;
// ask-user-question.test.ts pins them so a drift fails loudly instead of
// silently regressing to "the user did not answer the questions".

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export interface QuestionAnswer {
  /** Chosen option labels. Joined with ", " for multiSelect. */
  selected: string[]
  /** Free-text answer. Takes precedence over `selected` when non-empty —
   *  it's the "Other" escape hatch, not an addition to the options. */
  custom: string
}

export interface QuestionResult {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function parseOption(raw: unknown): QuestionOption | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const label = asString(o['label'])
  if (!label) return null
  return {
    label,
    ...(asString(o['description']) && { description: String(o['description']) }),
    ...(asString(o['preview']) && { preview: String(o['preview']) })
  }
}

/** Defensive parse — the input arrives over the approval socket, so a
 *  malformed `questions` array must degrade to "render nothing" rather
 *  than throw inside the chat view. */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = input['questions']
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const q = entry as Record<string, unknown>
    const question = asString(q['question'])
    if (!question) continue
    const options = Array.isArray(q['options'])
      ? q['options'].map(parseOption).filter((o): o is QuestionOption => o !== null)
      : []
    out.push({
      question,
      ...(asString(q['header']) && { header: String(q['header']) }),
      ...(q['multiSelect'] === true && { multiSelect: true }),
      options
    })
  }
  return out
}

/** Resolve one question's answer to the string the tool expects, or null
 *  when it should be omitted entirely (the user skipped it). */
export function encodeAnswer(answer: QuestionAnswer | undefined): string | null {
  if (!answer) return null
  const custom = answer.custom.trim()
  if (custom) return custom
  if (answer.selected.length === 0) return null
  return answer.selected.join(', ')
}

export function buildQuestionResult(
  input: Record<string, unknown>,
  questions: Question[],
  answers: Record<string, QuestionAnswer>,
  response?: string
): QuestionResult {
  const encodedAnswers: Record<string, string> = {}
  const annotations: Record<string, { preview?: string }> = {}

  for (const q of questions) {
    const encoded = encodeAnswer(answers[q.question])
    if (encoded === null) continue
    encodedAnswers[q.question] = encoded
    // Only a single-select pick maps back onto exactly one option, and
    // the binary only supports previews for single-select anyway.
    const picked = q.options.find((o) => o.label === encoded)
    if (picked?.preview) annotations[q.question] = { preview: picked.preview }
  }

  const trimmedResponse = response?.trim()
  return {
    behavior: 'allow',
    updatedInput: {
      ...input,
      answers: encodedAnswers,
      annotations,
      ...(trimmedResponse && { response: trimmedResponse })
    }
  }
}
