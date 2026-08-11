import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { parsePorcelainPaths } from './fork-relocation'

describe('parsePorcelainPaths', () => {
  it('keeps the full path when only the worktree is modified', () => {
    // The unstaged-only status is " M <path>" — a leading space. Trimming
    // the line before slicing the fixed-width columns eats two characters
    // of the filename and reports `pp.js` instead of `app.js`.
    expect(parsePorcelainPaths(' M app.js\n')).toEqual(['app.js'])
  })

  it('handles staged, unstaged, and untracked entries together', () => {
    const out = ['A  added.js', 'M  staged.js', ' D deleted.js', '?? untracked.js', ''].join('\n')
    expect(parsePorcelainPaths(out)).toEqual([
      'added.js',
      'staged.js',
      'deleted.js',
      'untracked.js'
    ])
  })

  it('reports the destination path for renames', () => {
    expect(parsePorcelainPaths('R  old/name.js -> new/name.js\n')).toEqual(['new/name.js'])
  })

  it('preserves paths with spaces', () => {
    expect(parsePorcelainPaths(' M src/my file.js\n')).toEqual(['src/my file.js'])
  })

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelainPaths('')).toEqual([])
    expect(parsePorcelainPaths('\n')).toEqual([])
  })
})
