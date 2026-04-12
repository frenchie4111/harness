import { app } from 'electron'
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getControlServerInfo } from './control-server'
import { log } from './debug'

function getConfigDir(): string {
  const dir = join(app.getPath('userData'), 'mcp-configs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getBridgeScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'mcp-bridge.js')
  }
  return join(__dirname, '../../resources/mcp-bridge.js')
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Write a per-terminal MCP config file pointing Claude Code at the bundled
 * harness-control MCP server. Returns the absolute path, or null if the
 * control server isn't running. Uses `ELECTRON_RUN_AS_NODE=1` so the Electron
 * binary executes the bridge script as a plain Node process — no separate
 * Node install required.
 */
export function writeMcpConfigForTerminal(terminalId: string): string | null {
  const info = getControlServerInfo()
  if (!info) {
    log('mcp', 'control server not ready — skipping MCP config write')
    return null
  }
  const configPath = join(getConfigDir(), `${sanitize(terminalId)}.json`)
  const config = {
    mcpServers: {
      'harness-control': {
        command: process.execPath,
        args: [getBridgeScriptPath()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HARNESS_PORT: String(info.port),
          HARNESS_TOKEN: info.token,
          HARNESS_TERMINAL_ID: terminalId
        }
      }
    }
  }
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    return configPath
  } catch (err) {
    log('mcp', 'failed to write config', err instanceof Error ? err.message : err)
    return null
  }
}

/** Remove mcp config files for terminals not present in `keepIds`. */
export function pruneMcpConfigs(keepIds: Set<string>): void {
  try {
    const dir = getConfigDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitize(id)}.json`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try {
          unlinkSync(join(dir, file))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
