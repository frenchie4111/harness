import { describe, it, expect } from 'vitest'
import { buildSpawnArgs } from './codex'

describe('codex buildSpawnArgs with harnessControl', () => {
  it('emits -c mcp_servers.harness-control.* with literal values', () => {
    const cmd = buildSpawnArgs({
      command: 'codex',
      cwd: '/wt',
      harnessControl: {
        execPath: '/abs/Electron',
        bridgePath: '/abs/bridge.js',
        port: 9999,
        token: 'secret',
        terminalId: 'term-1',
        workspaceId: '/wt',
        repoRoot: '/repo',
        isMain: true
      }
    })
    console.log('SPAWN:', cmd)
    expect(cmd).toContain('-c')
    expect(cmd).toContain('mcp_servers.harness-control.command')
    expect(cmd).toContain('"/abs/Electron"')
    expect(cmd).toContain('"/abs/bridge.js"')
    expect(cmd).toContain('HARNESS_PORT="9999"')
    expect(cmd).toContain('HARNESS_TOKEN="secret"')
    expect(cmd).toContain('HARNESS_TERMINAL_ID="term-1"')
    expect(cmd).toContain('HARNESS_IS_MAIN="1"')
  })
})
