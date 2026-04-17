import { describe, it, expect, vi } from 'vitest'

vi.mock('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

vi.mock('../hooks', () => ({
  makeHookCommand: () => 'echo hook'
}))

import { buildSpawnArgs } from './claude'

describe('buildSpawnArgs', () => {
  const base = { command: 'claude', cwd: '/tmp/test' }

  it('includes --append-system-prompt when systemPrompt is provided', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: 'You are in Harness.' })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain('You are in Harness.')
  })

  it('omits --append-system-prompt when systemPrompt is undefined', () => {
    const result = buildSpawnArgs({ ...base })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('omits --append-system-prompt when systemPrompt is empty', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: '' })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('shell-quotes the system prompt safely', () => {
    const prompt = "it's a \"test\" with\nnewlines"
    const result = buildSpawnArgs({ ...base, systemPrompt: prompt })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain("'\\''")
  })
})
