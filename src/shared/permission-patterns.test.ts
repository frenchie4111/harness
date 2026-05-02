import { describe, it, expect } from 'vitest'
import { suggestPermissionPatterns } from './permission-patterns'

describe('suggestPermissionPatterns', () => {
  it('Bash with multi-word command yields narrow + medium + broad', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'git status' })
    expect(out.map((s) => s.rule)).toEqual([
      'Bash(git status:*)',
      'Bash(git:*)',
      'Bash(*)'
    ])
    expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
  })

  it('Bash with one-word command collapses narrow into medium', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'ls' })
    expect(out.map((s) => s.rule)).toEqual(['Bash(ls:*)', 'Bash(*)'])
    expect(out.map((s) => s.scope)).toEqual(['medium', 'broad'])
  })

  it('Bash with extra whitespace tokenizes correctly', () => {
    const out = suggestPermissionPatterns('Bash', { command: '  npm   test  ' })
    expect(out.map((s) => s.rule)).toEqual([
      'Bash(npm test:*)',
      'Bash(npm:*)',
      'Bash(*)'
    ])
  })

  it('Bash with no command falls back to broad-only', () => {
    const out = suggestPermissionPatterns('Bash', {})
    expect(out).toEqual([{ rule: 'Bash(*)', label: 'Bash(*)', scope: 'broad' }])
  })

  it('Read with absolute path yields exact + parent glob + any', () => {
    const out = suggestPermissionPatterns('Read', {
      file_path: '/abs/path/foo.ts'
    })
    expect(out.map((s) => s.rule)).toEqual([
      'Read(/abs/path/foo.ts)',
      'Read(/abs/path/**)',
      'Read(*)'
    ])
    expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
  })

  it('Write with shallow path still yields the parent-dir glob', () => {
    const out = suggestPermissionPatterns('Write', { file_path: '/foo.txt' })
    // parentDir returns null for "/foo.txt" (single leading slash, no
    // intermediate dir worth globbing) so the medium suggestion is dropped.
    expect(out.map((s) => s.rule)).toEqual([
      'Write(/foo.txt)',
      'Write(*)'
    ])
  })

  it('Edit / MultiEdit follow the same shape as Read/Write', () => {
    const edit = suggestPermissionPatterns('Edit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(edit[0].rule).toBe('Edit(/repo/src/foo.ts)')
    expect(edit[1].rule).toBe('Edit(/repo/src/**)')
    expect(edit[2].rule).toBe('Edit(*)')

    const multi = suggestPermissionPatterns('MultiEdit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(multi[0].rule).toBe('MultiEdit(/repo/src/foo.ts)')
  })

  it('Read with no file_path falls back to bare tool name + broad', () => {
    const out = suggestPermissionPatterns('Read', {})
    expect(out.map((s) => s.rule)).toEqual(['Read', 'Read(*)'])
  })

  it('Grep / Glob produce pattern + broad', () => {
    expect(
      suggestPermissionPatterns('Grep', { pattern: 'TODO' }).map((s) => s.rule)
    ).toEqual(['Grep(TODO)', 'Grep(*)'])
    expect(
      suggestPermissionPatterns('Glob', { pattern: '**/*.ts' }).map(
        (s) => s.rule
      )
    ).toEqual(['Glob(**/*.ts)', 'Glob(*)'])
  })

  it('Grep with no pattern collapses to broad-only', () => {
    expect(suggestPermissionPatterns('Grep', {}).map((s) => s.rule)).toEqual([
      'Grep(*)'
    ])
  })

  it('WebFetch extracts host correctly from URL with path + query', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'https://example.com/path?query=1'
    })
    expect(out.map((s) => s.rule)).toEqual([
      'WebFetch(https://example.com/path?query=1)',
      'WebFetch(domain:example.com)',
      'WebFetch(*)'
    ])
  })

  it('WebFetch with port retains it in the host', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'http://localhost:3000/foo'
    })
    expect(out[1].rule).toBe('WebFetch(domain:localhost:3000)')
  })

  it('WebFetch with no url collapses to broad-only', () => {
    expect(
      suggestPermissionPatterns('WebFetch', {}).map((s) => s.rule)
    ).toEqual(['WebFetch(*)'])
  })

  it('MCP tool yields a single bare-name suggestion', () => {
    const out = suggestPermissionPatterns(
      'mcp__harness-control__create_worktree',
      { foo: 'bar' }
    )
    expect(out).toEqual([
      {
        rule: 'mcp__harness-control__create_worktree',
        label: 'mcp__harness-control__create_worktree',
        scope: 'narrow'
      }
    ])
  })

  it('Unknown tool name produces just the bare name', () => {
    const out = suggestPermissionPatterns('TodoWrite', undefined)
    expect(out).toEqual([
      { rule: 'TodoWrite', label: 'TodoWrite', scope: 'narrow' }
    ])
  })

  it('Empty tool name returns a defensive any-tool suggestion', () => {
    const out = suggestPermissionPatterns('', undefined)
    expect(out).toEqual([{ rule: '*', label: '* (any tool)', scope: 'broad' }])
  })
})
