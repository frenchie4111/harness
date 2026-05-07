import { describe, it, expect } from 'vitest'
import { extractQuestions } from './AskUserQuestionCard'

describe('extractQuestions', () => {
  it('parses a well-formed single-question input', () => {
    const out = extractQuestions({
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'Day.js', description: 'lightweight' },
            { label: 'date-fns' }
          ]
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('Which library?')
    expect(out[0].header).toBe('Library')
    expect(out[0].multiSelect).toBe(false)
    expect(out[0].options).toEqual([
      { label: 'Day.js', description: 'lightweight', preview: undefined },
      { label: 'date-fns', description: undefined, preview: undefined }
    ])
  })

  it('parses multi-select and multi-question shapes', () => {
    const out = extractQuestions({
      questions: [
        {
          question: 'Q1?',
          header: 'h1',
          multiSelect: true,
          options: [{ label: 'a' }, { label: 'b' }]
        },
        {
          question: 'Q2?',
          header: 'h2',
          multiSelect: false,
          options: [{ label: 'x' }, { label: 'y' }]
        }
      ]
    })
    expect(out).toHaveLength(2)
    expect(out[0].multiSelect).toBe(true)
    expect(out[1].multiSelect).toBe(false)
  })

  it('drops malformed entries (missing fields, wrong types)', () => {
    const out = extractQuestions({
      questions: [
        // missing question text
        { header: 'x', options: [{ label: 'a' }], multiSelect: false },
        // options not an array
        { question: 'Q?', header: 'h', options: 'nope', multiSelect: false },
        // valid
        {
          question: 'OK?',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'yes' }, { label: 'no' }]
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].question).toBe('OK?')
  })

  it('returns [] when input is undefined or has no questions array', () => {
    expect(extractQuestions(undefined)).toEqual([])
    expect(extractQuestions({})).toEqual([])
    expect(extractQuestions({ questions: 'nope' })).toEqual([])
  })
})
