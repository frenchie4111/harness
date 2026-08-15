import { describe, it, expect } from 'vitest'
import {
  buildQuestionResult,
  encodeAnswer,
  parseQuestions,
  type Question
} from './ask-user-question'

// These assertions pin the undocumented contract of the bundled claude
// binary's AskUserQuestion tool. If a future claude-code release changes
// how it reads answers back, these fail loudly — which is much better
// than the silent regression they were written for, where every answer
// was dropped and the model was told "the user did not answer".

const QUESTIONS: Question[] = [
  {
    question: 'How would you like to proceed?',
    header: 'Process',
    options: [
      { label: 'Fix all right away', description: 'No judgment calls' },
      { label: 'Let me pick', preview: 'item 1\nitem 2' }
    ]
  },
  {
    question: 'Which reply mode?',
    multiSelect: true,
    options: [{ label: 'Reply' }, { label: 'Resolve' }]
  }
]

const INPUT = { questions: QUESTIONS, metadata: { source: 'test' } }

describe('parseQuestions', () => {
  it('reads questions, headers, options and multiSelect', () => {
    const parsed = parseQuestions(INPUT as unknown as Record<string, unknown>)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.header).toBe('Process')
    expect(parsed[0]?.options[1]?.preview).toBe('item 1\nitem 2')
    expect(parsed[1]?.multiSelect).toBe(true)
  })

  it('returns [] rather than throwing on malformed input', () => {
    expect(parseQuestions({})).toEqual([])
    expect(parseQuestions({ questions: 'nope' })).toEqual([])
    expect(parseQuestions({ questions: [null, 42, {}] })).toEqual([])
  })

  it('drops options with no label', () => {
    const parsed = parseQuestions({
      questions: [{ question: 'q', options: [{ label: 'ok' }, { nope: 1 }] }]
    })
    expect(parsed[0]?.options).toEqual([{ label: 'ok' }])
  })
})

describe('encodeAnswer', () => {
  it('omits unanswered questions so they read as "(no option selected)"', () => {
    expect(encodeAnswer(undefined)).toBeNull()
    expect(encodeAnswer({ selected: [], custom: '' })).toBeNull()
    expect(encodeAnswer({ selected: [], custom: '   ' })).toBeNull()
  })

  it('joins multiSelect labels with ", " — not an array', () => {
    expect(encodeAnswer({ selected: ['Reply', 'Resolve'], custom: '' })).toBe(
      'Reply, Resolve'
    )
  })

  it('lets free text win over a stale selection', () => {
    expect(encodeAnswer({ selected: ['Reply'], custom: 'something else' })).toBe(
      'something else'
    )
  })
})

describe('buildQuestionResult', () => {
  it('puts answers on updatedInput and preserves the original input', () => {
    const result = buildQuestionResult(INPUT as never, QUESTIONS, {
      'How would you like to proceed?': {
        selected: ['Fix all right away'],
        custom: ''
      },
      'Which reply mode?': { selected: ['Reply', 'Resolve'], custom: '' }
    })

    expect(result.behavior).toBe('allow')
    expect(result.updatedInput['answers']).toEqual({
      'How would you like to proceed?': 'Fix all right away',
      'Which reply mode?': 'Reply, Resolve'
    })
    // The tool re-reads its whole input, so anything we drop is lost.
    expect(result.updatedInput['metadata']).toEqual({ source: 'test' })
    expect(result.updatedInput['questions']).toBe(QUESTIONS)
  })

  it('carries the selected option preview into annotations', () => {
    const result = buildQuestionResult(INPUT as never, QUESTIONS, {
      'How would you like to proceed?': { selected: ['Let me pick'], custom: '' }
    })
    expect(result.updatedInput['annotations']).toEqual({
      'How would you like to proceed?': { preview: 'item 1\nitem 2' }
    })
  })

  it('omits skipped questions entirely', () => {
    const result = buildQuestionResult(INPUT as never, QUESTIONS, {})
    expect(result.updatedInput['answers']).toEqual({})
    expect(result.updatedInput['annotations']).toEqual({})
  })

  it('sets response for the free-text reply path', () => {
    const result = buildQuestionResult(
      INPUT as never,
      QUESTIONS,
      {},
      '  neither, do X instead  '
    )
    expect(result.updatedInput['response']).toBe('neither, do X instead')
  })

  it('leaves response off when blank', () => {
    const result = buildQuestionResult(INPUT as never, QUESTIONS, {}, '   ')
    expect('response' in result.updatedInput).toBe(false)
  })
})
