import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchSettings } from './claude-launch'
import {
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN
} from './persistence'
import type { Worktree } from '../shared/state/worktrees'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/repo/feat-x',
    branch: 'feat-x',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/tmp/repo',
    ...overrides
  }
}

describe('buildClaudeLaunchSettings', () => {
  it('returns the base harness system prompt for a non-main worktree', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.systemPrompt).toBe(DEFAULT_HARNESS_SYSTEM_PROMPT)
  })

  it('appends the main-worktree addition when isMain', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.systemPrompt).toBe(
      `${DEFAULT_HARNESS_SYSTEM_PROMPT}\n\n${DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN}`
    )
  })

  it('honors custom harnessSystemPrompt + harnessSystemPromptMain overrides', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {
        harnessSystemPrompt: 'BASE',
        harnessSystemPromptMain: 'MAIN'
      }
    })
    expect(out.systemPrompt).toBe('BASE\n\nMAIN')
  })

  it('omits systemPrompt entirely when harnessSystemPromptEnabled is false', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { harnessSystemPromptEnabled: false }
    })
    expect(out.systemPrompt).toBeUndefined()
  })

  it('omits systemPrompt when both base and addition are blank strings', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { harnessSystemPrompt: '   ', harnessSystemPromptMain: '   ' }
    })
    expect(out.systemPrompt).toBeUndefined()
  })

  it('returns model when claudeModel is set, undefined otherwise', () => {
    const wt = makeWorktree()
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeModel: 'opus' }
      }).model
    ).toBe('opus')
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: {}
      }).model
    ).toBeUndefined()
  })

  it('builds sessionName from repoLabel/branch when nameClaudeSessions is on', () => {
    const wt = makeWorktree({ repoRoot: '/Users/x/code/myrepo', branch: 'feat-x' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { nameClaudeSessions: true }
    })
    expect(out.sessionName).toBe('myrepo/feat-x')
  })

  it('omits sessionName when nameClaudeSessions is unset', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.sessionName).toBeUndefined()
  })

  it('omits sessionName when nameClaudeSessions is on but the worktree is unknown', () => {
    const out = buildClaudeLaunchSettings({
      cwd: '/tmp/unknown',
      worktrees: [],
      config: { nameClaudeSessions: true }
    })
    expect(out.sessionName).toBeUndefined()
  })

  it('tuiFullscreen defaults to true and respects an explicit false', () => {
    const wt = makeWorktree()
    expect(
      buildClaudeLaunchSettings({ cwd: wt.path, worktrees: [wt], config: {} })
        .tuiFullscreen
    ).toBe(true)
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeTuiFullscreen: false }
      }).tuiFullscreen
    ).toBe(false)
  })
})
