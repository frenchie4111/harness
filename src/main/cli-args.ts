export interface CliFlags {
  port?: number
  host?: string
  showHelp: boolean
  showVersion: boolean
}

export type ParseResult =
  | { kind: 'ok'; flags: CliFlags }
  | { kind: 'error'; message: string }

export const USAGE = `harness-server — Harness headless backend

Usage: harness-server [options]

Options:
  --host <addr>      Bind to address (default: 127.0.0.1)
                     Common values: 0.0.0.0 (all interfaces), or a
                     specific interface IP like $(tailscale ip -4)
  --port <num>       Bind to port (default: 37291; 0 = ephemeral)
  --version          Print version and exit
  --help             Print this help and exit

Environment:
  HARNESS_WS_HOST    Same as --host (CLI flag wins)
  HARNESS_WS_PORT    Same as --port (CLI flag wins)
  HARNESS_DATA_DIR   Where config + auth tokens live (default: ~/.harness)

Examples:
  harness-server                                    # localhost only
  harness-server --host 0.0.0.0                     # all interfaces
  harness-server --host $(tailscale ip -4)          # tailscale only
  harness-server --port 0                           # ephemeral port
`

export function parseCliFlags(argv: string[]): ParseResult {
  const flags: CliFlags = { showHelp: false, showVersion: false }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''

    if (a === '--help' || a === '-h') {
      flags.showHelp = true
      continue
    }
    if (a === '--version' || a === '-v') {
      flags.showVersion = true
      continue
    }

    if (a === '--port' || a === '--host') {
      const next = argv[i + 1]
      if (next == null) {
        return { kind: 'error', message: `missing value for ${a}` }
      }
      const result = applyValue(flags, a, next)
      if (result.kind === 'error') return result
      i += 1
      continue
    }

    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq !== -1) {
      const name = a.slice(0, eq)
      const value = a.slice(eq + 1)
      if (name === '--port' || name === '--host') {
        const result = applyValue(flags, name, value)
        if (result.kind === 'error') return result
        continue
      }
      return { kind: 'error', message: `unknown option: ${name}` }
    }

    return { kind: 'error', message: `unknown option: ${a}` }
  }

  return { kind: 'ok', flags }
}

function applyValue(
  flags: CliFlags,
  name: '--port' | '--host',
  raw: string
): ParseResult {
  if (name === '--port') {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0 || n > 65535) {
      return { kind: 'error', message: `invalid port: ${raw}` }
    }
    flags.port = n
    return { kind: 'ok', flags }
  }
  if (!raw) {
    return { kind: 'error', message: `invalid host: ${raw}` }
  }
  flags.host = raw
  return { kind: 'ok', flags }
}
