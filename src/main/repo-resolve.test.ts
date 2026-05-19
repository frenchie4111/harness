import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'
import { resolveRepoPath } from './repo-resolve'

describe('resolveRepoPath', () => {
  let root: string
  let repo: string
  let nested: string
  let plain: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-repo-resolve-'))
    repo = join(root, 'my-repo')
    nested = join(repo, 'src')
    plain = join(root, 'just-a-folder')
    mkdirSync(repo)
    mkdirSync(nested)
    mkdirSync(plain)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns ok when picked is the repo toplevel', async () => {
    const result = await resolveRepoPath(repo)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.root).toBe(resolvePath(repo))
    }
  })

  it('returns walked-up when picked is a subdir of a repo', async () => {
    const result = await resolveRepoPath(nested)
    expect(result.kind).toBe('walked-up')
    if (result.kind === 'walked-up') {
      expect(result.picked).toBe(resolvePath(nested))
      // The resolved root should land on the real repo, ignoring
      // macOS /private symlink prefixes.
      expect(result.resolved.endsWith('/my-repo')).toBe(true)
    }
  })

  it('returns not-a-repo for a directory with no git ancestor', async () => {
    const result = await resolveRepoPath(plain)
    expect(result.kind).toBe('not-a-repo')
  })

  it('returns not-a-repo for empty / invalid input', async () => {
    const result = await resolveRepoPath('')
    expect(result.kind).toBe('not-a-repo')
  })
})
