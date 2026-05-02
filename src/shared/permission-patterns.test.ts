import { describe, it, expect } from 'vitest'
import {
  suggestPermissionPatterns,
  isFileToolCrossCwd
} from './permission-patterns'

describe('suggestPermissionPatterns', () => {
  it('Bash with multi-word command yields narrow + medium + broad', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'git status' })
    expect(out).toEqual([
      {
        rule: { toolName: 'Bash', ruleContent: 'git status:*' },
        label: 'Bash(git status:*)',
        scope: 'narrow'
      },
      {
        rule: { toolName: 'Bash', ruleContent: 'git:*' },
        label: 'Bash(git:*)',
        scope: 'medium'
      },
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Bash with one-word command collapses narrow into medium', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'ls' })
    expect(out).toEqual([
      {
        rule: { toolName: 'Bash', ruleContent: 'ls:*' },
        label: 'Bash(ls:*)',
        scope: 'medium'
      },
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Bash with extra whitespace tokenizes correctly', () => {
    const out = suggestPermissionPatterns('Bash', {
      command: '  npm   test  '
    })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Bash', ruleContent: 'npm:*' },
      { toolName: 'Bash' }
    ])
  })

  it('Bash with no command falls back to broad-only', () => {
    const out = suggestPermissionPatterns('Bash', {})
    expect(out).toEqual([
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Read with absolute path yields exact + parent glob + bare', () => {
    const out = suggestPermissionPatterns('Read', {
      file_path: '/abs/path/foo.ts'
    })
    expect(out).toEqual([
      {
        rule: { toolName: 'Read', ruleContent: '/abs/path/foo.ts' },
        label: 'Read(/abs/path/foo.ts)',
        scope: 'narrow'
      },
      {
        rule: { toolName: 'Read', ruleContent: '/abs/path/**' },
        label: 'Read(/abs/path/**)',
        scope: 'medium'
      },
      { rule: { toolName: 'Read' }, label: 'Read', scope: 'broad' }
    ])
  })

  it('Write with shallow path drops the parent-dir glob', () => {
    const out = suggestPermissionPatterns('Write', { file_path: '/foo.txt' })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'Write', ruleContent: '/foo.txt' },
      { toolName: 'Write' }
    ])
  })

  it('Edit / MultiEdit follow the same shape as Read/Write', () => {
    const edit = suggestPermissionPatterns('Edit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(edit.map((s) => s.rule)).toEqual([
      { toolName: 'Edit', ruleContent: '/repo/src/foo.ts' },
      { toolName: 'Edit', ruleContent: '/repo/src/**' },
      { toolName: 'Edit' }
    ])

    const multi = suggestPermissionPatterns('MultiEdit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(multi[0].rule).toEqual({
      toolName: 'MultiEdit',
      ruleContent: '/repo/src/foo.ts'
    })
  })

  it('Read with no file_path falls back to broad-only', () => {
    const out = suggestPermissionPatterns('Read', {})
    expect(out).toEqual([
      { rule: { toolName: 'Read' }, label: 'Read', scope: 'broad' }
    ])
  })

  it('Grep / Glob produce pattern + bare', () => {
    expect(
      suggestPermissionPatterns('Grep', { pattern: 'TODO' }).map((s) => s.rule)
    ).toEqual([
      { toolName: 'Grep', ruleContent: 'TODO' },
      { toolName: 'Grep' }
    ])
    expect(
      suggestPermissionPatterns('Glob', { pattern: '**/*.ts' }).map(
        (s) => s.rule
      )
    ).toEqual([
      { toolName: 'Glob', ruleContent: '**/*.ts' },
      { toolName: 'Glob' }
    ])
  })

  it('Grep with no pattern collapses to broad-only', () => {
    expect(suggestPermissionPatterns('Grep', {}).map((s) => s.rule)).toEqual([
      { toolName: 'Grep' }
    ])
  })

  it('WebFetch extracts host correctly from URL with path + query', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'https://example.com/path?query=1'
    })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'WebFetch', ruleContent: 'https://example.com/path?query=1' },
      { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
      { toolName: 'WebFetch' }
    ])
  })

  it('WebFetch with port retains it in the host', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'http://localhost:3000/foo'
    })
    expect(out[1].rule).toEqual({
      toolName: 'WebFetch',
      ruleContent: 'domain:localhost:3000'
    })
  })

  it('WebFetch with no url collapses to broad-only', () => {
    expect(
      suggestPermissionPatterns('WebFetch', {}).map((s) => s.rule)
    ).toEqual([{ toolName: 'WebFetch' }])
  })

  it('MCP tool yields a single bare-name suggestion', () => {
    const out = suggestPermissionPatterns(
      'mcp__harness-control__create_worktree',
      { foo: 'bar' }
    )
    expect(out).toEqual([
      {
        rule: { toolName: 'mcp__harness-control__create_worktree' },
        label: 'mcp__harness-control__create_worktree',
        scope: 'narrow'
      }
    ])
  })

  it('Unknown tool name produces just the bare name', () => {
    const out = suggestPermissionPatterns('TodoWrite', undefined)
    expect(out).toEqual([
      { rule: { toolName: 'TodoWrite' }, label: 'TodoWrite', scope: 'narrow' }
    ])
  })

  it('Empty tool name returns a defensive any-tool suggestion', () => {
    const out = suggestPermissionPatterns('', undefined)
    expect(out).toEqual([
      { rule: { toolName: '*' }, label: '* (any tool)', scope: 'broad' }
    ])
  })

  describe('cross-cwd file paths', () => {
    const cwd = '/Users/me/proj'

    it('inside cwd: still emits narrow + medium + broad', () => {
      const out = suggestPermissionPatterns(
        'Write',
        { file_path: '/Users/me/proj/src/foo.ts' },
        cwd
      )
      expect(out.map((s) => s.rule)).toEqual([
        { toolName: 'Write', ruleContent: '/Users/me/proj/src/foo.ts' },
        { toolName: 'Write', ruleContent: '/Users/me/proj/src/**' },
        { toolName: 'Write' }
      ])
    })

    it('outside cwd: only emits the bare-tool grant', () => {
      const out = suggestPermissionPatterns(
        'Write',
        { file_path: '/tmp/foo.txt' },
        cwd
      )
      expect(out).toEqual([
        { rule: { toolName: 'Write' }, label: 'Write', scope: 'broad' }
      ])
    })

    it('cwd unsupplied: behaves as before (narrow + medium + broad)', () => {
      const out = suggestPermissionPatterns(
        'Write',
        { file_path: '/tmp/foo.txt' }
      )
      expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
    })

    it('relative file_path is treated as inside cwd', () => {
      const out = suggestPermissionPatterns(
        'Read',
        { file_path: 'src/foo.ts' },
        cwd
      )
      expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
    })

    it('exact cwd match counts as inside', () => {
      const out = suggestPermissionPatterns(
        'Read',
        { file_path: '/Users/me/proj' },
        cwd
      )
      expect(out.length).toBeGreaterThan(1)
    })

    it('cwd with trailing slash works', () => {
      const out = suggestPermissionPatterns(
        'Write',
        { file_path: '/Users/me/proj/foo.ts' },
        '/Users/me/proj/'
      )
      expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
    })

    it('similarly-prefixed dir is NOT considered inside (no false-positive)', () => {
      // /Users/me/proj-other should not be treated as inside /Users/me/proj
      const out = suggestPermissionPatterns(
        'Write',
        { file_path: '/Users/me/proj-other/foo.ts' },
        cwd
      )
      expect(out).toEqual([
        { rule: { toolName: 'Write' }, label: 'Write', scope: 'broad' }
      ])
    })
  })

  describe('isFileToolCrossCwd', () => {
    const cwd = '/Users/me/proj'

    it('true for file tool with absolute path outside cwd', () => {
      expect(
        isFileToolCrossCwd('Write', { file_path: '/tmp/foo.txt' }, cwd)
      ).toBe(true)
    })

    it('false for file tool inside cwd', () => {
      expect(
        isFileToolCrossCwd(
          'Write',
          { file_path: '/Users/me/proj/foo.ts' },
          cwd
        )
      ).toBe(false)
    })

    it('false when no cwd is provided', () => {
      expect(
        isFileToolCrossCwd('Write', { file_path: '/tmp/foo.txt' }, undefined)
      ).toBe(false)
    })

    it('false for non-file tools', () => {
      expect(
        isFileToolCrossCwd('Bash', { command: 'ls /tmp' }, cwd)
      ).toBe(false)
    })

    it('false when no file_path is present', () => {
      expect(isFileToolCrossCwd('Write', {}, cwd)).toBe(false)
    })

    it('false for relative paths', () => {
      expect(
        isFileToolCrossCwd('Read', { file_path: 'src/foo.ts' }, cwd)
      ).toBe(false)
    })
  })
})
