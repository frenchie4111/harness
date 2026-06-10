import { describe, it, expect } from 'vitest'
import { parseBranchCommitLog } from './worktree'

const FIELD = '\x1f'
const RECORD = '\x1e'

function record(fields: string[]): string {
  return fields.join(FIELD) + RECORD
}

describe('parseBranchCommitLog', () => {
  it('parses well-formed records into fully-populated commits', () => {
    const stdout =
      record(['aaa111', 'aaa', 'First commit', 'Alice', '2 hours ago', '1700000000']) +
      record(['bbb222', 'bbb', 'Second commit', 'Bob', '3 hours ago', '1700000100'])

    const commits = parseBranchCommitLog(stdout, null)

    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      hash: 'aaa111',
      shortHash: 'aaa',
      subject: 'First commit',
      author: 'Alice',
      relativeDate: '2 hours ago',
      timestamp: 1700000000,
      pushed: false
    })
  })

  it('does not produce undefined rows when a field contains a newline', () => {
    // A field with an embedded newline (e.g. a quirky author name or a
    // subject that survived as multi-line) must not break record boundaries.
    const stdout =
      record(['aaa111', 'aaa', 'Subject with\nembedded newline', 'Alice', '2 hours ago', '1700000000']) +
      record(['bbb222', 'bbb', 'Normal subject', 'Bob', '3 hours ago', '1700000100'])

    const commits = parseBranchCommitLog(stdout, null)

    expect(commits).toHaveLength(2)
    for (const c of commits) {
      expect(c.hash).toBeDefined()
      expect(c.shortHash).toBeDefined()
      expect(c.subject).toBeDefined()
      expect(c.author).toBeDefined()
      expect(c.relativeDate).toBeDefined()
    }
    expect(commits[0].subject).toBe('Subject with\nembedded newline')
    expect(commits[1].shortHash).toBe('bbb')
  })

  it('marks commits pushed/unpushed based on the unpushed set', () => {
    const stdout =
      record(['aaa111', 'aaa', 'Pushed', 'Alice', '2 hours ago', '1700000000']) +
      record(['bbb222', 'bbb', 'Unpushed', 'Bob', '3 hours ago', '1700000100'])

    const commits = parseBranchCommitLog(stdout, new Set(['bbb222']))

    expect(commits[0].pushed).toBe(true)
    expect(commits[1].pushed).toBe(false)
  })

  it('marks every commit unpushed when there is no tracking ref', () => {
    const stdout = record(['aaa111', 'aaa', 'Only commit', 'Alice', '2 hours ago', '1700000000'])

    const commits = parseBranchCommitLog(stdout, null)

    expect(commits[0].pushed).toBe(false)
  })

  it('skips malformed records that lack the expected field count', () => {
    const stdout =
      record(['aaa111', 'aaa', 'Good', 'Alice', '2 hours ago', '1700000000']) +
      'garbage-without-separators' +
      RECORD

    const commits = parseBranchCommitLog(stdout, null)

    expect(commits).toHaveLength(1)
    expect(commits[0].hash).toBe('aaa111')
  })

  it('returns an empty array for empty output', () => {
    expect(parseBranchCommitLog('', null)).toEqual([])
  })
})
