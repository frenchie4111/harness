// SSH bootstrap orchestrator — drives the VSCode-style "Connect to
// remote host" flow end to end. The renderer kicks this off via the
// `ssh:bootstrap` IPC handler; we dispatch progress events into the
// `sshBootstrap` slice so the modal's progress log renders live.
//
// Implementation reference: plans/remote-main.md §4.
//
// Lazy-loaded: node-ssh + ssh2 ship native bindings (ssh2's sshcrypto)
// and aren't shipped with the headless `harness-server` tarball. The
// IPC handler does `await import('./ssh-bootstrap')` so the require
// only fires in Electron mode, where the packaged app has the
// node_modules tree.

import type { NodeSSH } from 'node-ssh'
import { createRequire } from 'module'
import { createServer, type Server as NetServer, type Socket } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { homedir, userInfo } from 'os'
import { computeForHost } from './ssh-config'
import type {
  BootstrapError,
  BootstrapPhase
} from '../shared/state/ssh-bootstrap'

const dynamicRequire = createRequire(__filename)
function loadNodeSsh(): { NodeSSH: typeof NodeSSH } {
  return dynamicRequire('node-ssh')
}

/** Parsed form of either an `~/.ssh/config` alias or a freeform
 *  `user@host[:port]` string. `alias` is the canonical key the user
 *  picked; `connectConfig` is what we pass to node-ssh. */
export interface SshTarget {
  /** Raw user-supplied string — used as the persistable target and the
   *  default label suggestion. */
  raw: string
  /** Resolved Host alias for ssh2's config lookup. When the user types
   *  `user@host`, ssh2 still honors `~/.ssh/config`'s `Host *` blocks
   *  for IdentityFile / ProxyCommand / etc. */
  host: string
  user?: string
  port?: number
}

export function parseSshTarget(raw: string): SshTarget {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('empty SSH target')
  // user@host[:port] form
  const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(trimmed)
  if (!m) {
    // Fall back to treating the whole string as a Host alias.
    return { raw: trimmed, host: trimmed }
  }
  const [, user, host, portStr] = m
  const port = portStr ? Number(portStr) : undefined
  return {
    raw: trimmed,
    host,
    ...(user ? { user } : {}),
    ...(port && Number.isFinite(port) ? { port } : {})
  }
}

/** Expand a leading `~` to the user's home directory. ssh-config
 *  files typically reference IdentityFile as `~/.ssh/id_ed25519` —
 *  ssh2 wants an absolute path. */
function expandHome(p: string): string {
  if (p.startsWith('~/')) return p.replace(/^~/, homedir())
  if (p === '~') return homedir()
  return p
}

/** Build the ssh2 connect config for a target. Resolves User / Port /
 *  IdentityFile from ~/.ssh/config (since ssh2 doesn't), and falls
 *  back to the OS username if none of those sources have one. Logs
 *  the resolved values to the progress stream so the user can see
 *  what we ended up with.
 *
 *  Uses ssh-config's `compute()` rather than an alias-list lookup, so
 *  wildcard blocks like `Host *.gradle.org` are honored when the user
 *  types `mike@build.gradle.org` directly. Match here mirrors how the
 *  `ssh` binary itself applies config. */
async function resolveSshConnectConfig(
  target: SshTarget,
  onLine: (line: string) => void
): Promise<Record<string, unknown>> {
  const cfg: Record<string, unknown> = { host: target.host }
  // Compute against both the raw input (which might be a Host alias)
  // AND the parsed hostname — same key wins in OpenSSH first-match,
  // so we try the alias-y form first.
  let resolved: Awaited<ReturnType<typeof computeForHost>> = null
  if (target.raw && target.raw !== target.host) {
    resolved = await computeForHost(target.raw)
  }
  if (!resolved || (!resolved.user && !resolved.port && !resolved.identityFile && !resolved.hostName)) {
    const hostResolved = await computeForHost(target.host)
    if (hostResolved) resolved = hostResolved
  }

  // Username: explicit user@host wins, then ~/.ssh/config, then OS user.
  let username = target.user ?? resolved?.user
  if (!username) {
    try {
      username = userInfo().username
    } catch {
      // Best-effort — fall through and let ssh2 raise its own error.
    }
  }
  if (username) cfg.username = username

  // Port: explicit host:port wins, then ~/.ssh/config, else ssh2 default 22.
  const port = target.port ?? resolved?.port
  if (port) cfg.port = port

  // HostName from config takes precedence over the alias for the
  // actual TCP connect target. (E.g. `Host build` + `HostName build.lan`
  // — we want to connect to build.lan, not "build".)
  if (resolved?.hostName && resolved.hostName !== target.host) {
    cfg.host = resolved.hostName
  }

  // IdentityFile: best-effort. If the agent has the key, this is
  // redundant; if not, we need it. compute() picks up wildcard blocks
  // (`Host *.gradle.org IdentityFile …`) that the alias-list lookup
  // missed.
  if (resolved?.identityFile) {
    cfg.privateKeyPath = expandHome(resolved.identityFile)
  }

  // Forward the SSH agent socket so agent-loaded keys are tried
  // automatically (matches the behavior of the `ssh` binary). Without
  // this, ssh2 only tries the explicit privateKey path. node-ssh /
  // ssh2 honors `agent` natively.
  if (process.env.SSH_AUTH_SOCK) {
    cfg.agent = process.env.SSH_AUTH_SOCK
  }

  // Keyboard-interactive fallback — some configs require it for
  // 2FA-style prompts. node-ssh's tryKeyboard flag enables it; we
  // don't currently surface a prompt UI, so this only helps when the
  // key in the agent + the keyboard-interactive layer don't conflict.
  cfg.tryKeyboard = false

  // Resolved-target log line — invaluable when something goes wrong.
  const parts: string[] = []
  parts.push(`host=${cfg.host}`)
  if (cfg.username) parts.push(`user=${cfg.username}`)
  if (cfg.port) parts.push(`port=${cfg.port}`)
  if (cfg.privateKeyPath) parts.push(`identity=${cfg.privateKeyPath}`)
  if (cfg.agent) parts.push('agent=$SSH_AUTH_SOCK')
  onLine(`resolved: ${parts.join(' ')}`)
  return cfg
}

/** Progress callback shape — the orchestrator yields these so the
 *  caller (IPC handler) can dispatch into the slice. Keeping the
 *  orchestrator slice-agnostic makes it trivial to unit-test. */
export interface BootstrapCallbacks {
  onPhase(phase: BootstrapPhase): void
  onLine(line: string): void
}

export interface BootstrapResult {
  /** Local loopback port the renderer should connect to. */
  localPort: number
  /** Auth token to include in the connection URL. */
  token: string
  /** Owns the SSH connection + tunnel. Caller should hand to the
   *  tunnel-manager which keeps it alive for the backend's lifetime. */
  ssh: NodeSSH
  tunnelServer: NetServer
  /** Remote port the server bound to (for diagnostics + future
   *  reconnect). */
  remotePort: number
}

/** Where the installed harness-server's binary lives on the remote.
 *  Matches `scripts/install-headless.sh`'s INSTALL_DIR default. */
const REMOTE_INSTALL_DIR = '~/.harness-server'
const REMOTE_BIN = `${REMOTE_INSTALL_DIR}/bin/harness-server`
const REMOTE_STATE_FILE = `${REMOTE_INSTALL_DIR}/state.json`
const REMOTE_LOG_FILE = `${REMOTE_INSTALL_DIR}/log`

/** Read from env so dev / CI can point the install script at a fork or
 *  staging release. Mirrors the script's HARNESS_SERVER_BASE_URL hook. */
function installScriptUrl(): string {
  const fork = process.env.HARNESS_INSTALL_SCRIPT_URL
  if (fork) return fork
  return 'https://raw.githubusercontent.com/frenchie4111/harness/main/scripts/install-headless.sh'
}

function installerEnvPrefix(): string {
  const base = process.env.HARNESS_SERVER_BASE_URL
  const version = process.env.HARNESS_SERVER_VERSION
  const parts: string[] = []
  if (base) parts.push(`HARNESS_SERVER_BASE_URL=${shellEscape(base)}`)
  if (version) parts.push(`HARNESS_SERVER_VERSION=${shellEscape(version)}`)
  return parts.length ? parts.join(' ') + ' ' : ''
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function asBootstrapError(err: unknown, fallback: BootstrapError): BootstrapError {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = err as { code?: unknown; message?: unknown }
    // ssh2 wraps connection problems with stable codes — translate the
    // common ones into our typed shape so the renderer can render a
    // structured error instead of just a stack trace.
    if (e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT') {
      return {
        code: 'host_unreachable',
        message: `could not reach host: ${String(e.message ?? e.code)}`
      }
    }
    if (
      e.code === 'ECONNREFUSED' ||
      String(e.message ?? '').includes('connect ECONNREFUSED')
    ) {
      return {
        code: 'host_unreachable',
        message: `connection refused (is sshd running on the target port?)`
      }
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  // ssh2 surfaces auth failures via various message shapes; sniff for them.
  if (
    /All configured authentication methods failed/i.test(msg) ||
    /Authentication failed/i.test(msg) ||
    /no matching key exchange/i.test(msg)
  ) {
    return {
      code: 'auth_failed',
      message:
        'SSH authentication failed. Add the right identity to your ssh-agent or specify IdentityFile in ~/.ssh/config.',
      detail: msg
    }
  }
  return { ...fallback, detail: msg }
}

/** Probe the remote for an existing `harness-server`. Returns the
 *  version string if found, null otherwise. */
async function probeServer(ssh: NodeSSH): Promise<string | null> {
  const probe = await ssh.execCommand(
    `test -x ${REMOTE_BIN} && ${REMOTE_BIN} --version 2>/dev/null || echo __NOT_INSTALLED__`
  )
  const out = probe.stdout.trim()
  if (!out || out === '__NOT_INSTALLED__') return null
  return out
}

/** Run the install script over SSH. Streams output into `onLine`. */
async function runInstall(ssh: NodeSSH, onLine: (line: string) => void): Promise<void> {
  const cmd = `${installerEnvPrefix()}curl -fsSL ${shellEscape(installScriptUrl())} | sh`
  const result = await ssh.execCommand(cmd, {
    onStdout: (chunk: Buffer) => emitLines(chunk.toString('utf8'), onLine),
    onStderr: (chunk: Buffer) => emitLines(chunk.toString('utf8'), onLine)
  })
  if (result.code !== 0) {
    // The installer already prints "error: ..." on failure; bubble it up
    // verbatim so the UI's progress log matches what the user would see
    // running the script by hand.
    const tail =
      [result.stderr, result.stdout].filter(Boolean).join('\n').trim() ||
      `install script exited with code ${result.code}`
    const err: BootstrapError = {
      code: tail.includes('unsupported')
        ? 'platform_unsupported'
        : 'install_failed',
      message: tail.split('\n').pop() ?? `install failed (exit ${result.code})`,
      detail: tail
    }
    throw Object.assign(new Error(err.message), { bootstrapError: err })
  }
}

function emitLines(chunk: string, onLine: (line: string) => void): void {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim()
    if (line) onLine(line)
  }
}

/** Try to read the persisted `state.json` left behind by a previous
 *  bootstrap. Returns null if missing or unparsable. */
interface RemoteState {
  port: number
  token: string
  pid: number
  startedAt: number
}
async function readRemoteState(ssh: NodeSSH): Promise<RemoteState | null> {
  const r = await ssh.execCommand(`cat ${REMOTE_STATE_FILE} 2>/dev/null || true`)
  const text = r.stdout.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number'
    ) {
      return parsed
    }
  } catch {
    // Stale or corrupt — ignore and re-bootstrap.
  }
  return null
}

/** Check whether a pid is currently alive on the remote. */
async function isPidAlive(ssh: NodeSSH, pid: number): Promise<boolean> {
  const r = await ssh.execCommand(`kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`)
  return r.stdout.trim() === 'ALIVE'
}

/** Start the server detached. Polls `~/.harness-server/log` for the
 *  `[web-client] open ...` line so we know what port it bound to. */
async function startServerDetached(
  ssh: NodeSSH,
  onLine: (line: string) => void
): Promise<RemoteState> {
  const token = randomBytes(32).toString('hex')
  // Detach so the server survives the SSH session closing:
  //   - `nohup` ignores SIGHUP when sshd tears down the channel.
  //   - Redirecting stdin to /dev/null + stdout/stderr to the log
  //     means the SSH channel doesn't keep the process tethered
  //     waiting for tty traffic.
  //   - The trailing `&` puts it in the background so we can read the
  //     pid and return immediately.
  //
  // Newlines (not `&&`) separate statements so `cmd &` followed by the
  // next line parses cleanly — the `& &&` form is a syntax error in any
  // POSIX shell. `disown` (bash-only) and `setsid` (not on every Unix)
  // are deliberately omitted; nohup + fd redirection is enough for
  // every shell we care about.
  const script = [
    `mkdir -p ${REMOTE_INSTALL_DIR}`,
    `: > ${REMOTE_LOG_FILE}`,
    `nohup env HARNESS_AUTH_TOKEN=${shellEscape(token)} HARNESS_WS_HOST=127.0.0.1 ${REMOTE_BIN} --port 0 --host 127.0.0.1 > ${REMOTE_LOG_FILE} 2>&1 < /dev/null &`,
    `echo $!`
  ].join('\n')
  const launch = await ssh.execCommand(`sh -s`, { stdin: script })
  if (launch.code !== 0) {
    throw Object.assign(new Error('failed to launch harness-server'), {
      bootstrapError: {
        code: 'server_start_failed',
        message: 'failed to launch harness-server',
        detail: launch.stderr || launch.stdout
      } satisfies BootstrapError
    })
  }
  const pid = Number(launch.stdout.trim()) || 0
  // Poll the log for the bound-port marker. The web-client server prints
  // `[web-client] open http://<host>:<port>/?token=...` once it's ready
  // — we match the port out of that line.
  const deadline = Date.now() + 10_000
  let port = 0
  let lastTail = ''
  while (Date.now() < deadline) {
    const tail = await ssh.execCommand(`tail -n 50 ${REMOTE_LOG_FILE} 2>/dev/null || true`)
    lastTail = tail.stdout
    const m = /\[web-client\] open https?:\/\/[^:]+:(\d+)\//.exec(lastTail)
    if (m) {
      port = Number(m[1])
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!port) {
    // Best-effort cleanup so we don't leave a zombie hogging resources.
    if (pid) await ssh.execCommand(`kill ${pid} 2>/dev/null || true`)
    const dump = lastTail.split('\n').slice(-50).join('\n')
    throw Object.assign(new Error('harness-server did not start within 10s'), {
      bootstrapError: {
        code: 'server_start_failed',
        message: 'harness-server did not print its bound port within 10s',
        detail: dump || 'no log output'
      } satisfies BootstrapError
    })
  }
  onLine(`server bound to remote port ${port}, pid ${pid}`)
  const state: RemoteState = { port, token, pid, startedAt: Date.now() }
  // Atomic write: tmp file + mv so a concurrent reader never sees a
  // truncated state.json. We're not racing anyone here today, but the
  // filesystem-level idempotence is cheap insurance for future
  // "reconnect from two Harnesses at once" scenarios.
  const payload = JSON.stringify(state)
  await ssh.execCommand(
    `printf '%s' ${shellEscape(payload)} > ${REMOTE_STATE_FILE}.tmp && mv ${REMOTE_STATE_FILE}.tmp ${REMOTE_STATE_FILE}`
  )
  return state
}

/** Set up SSH local port forwarding: connections to `localhost:<localPort>`
 *  on the user's machine are tunneled through SSH to `127.0.0.1:<remotePort>`
 *  on the remote. The returned NetServer owns the local listening socket;
 *  closing it tears the tunnel down (but does NOT kill the remote server). */
async function openTunnel(
  ssh: NodeSSH,
  remotePort: number,
  preferredLocalPort?: number
): Promise<{ server: NetServer; localPort: number }> {
  // Build a local TCP server that proxies each accepted connection
  // through ssh.forwardOut to 127.0.0.1:<remotePort>. Mirrors
  // `ssh -L localPort:127.0.0.1:remotePort` exactly.
  const tryListen = (port: number): Promise<{ server: NetServer; localPort: number }> =>
    new Promise((resolve, reject) => {
      const server = createServer((local: Socket) => {
        ssh
          .forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort)
          .then((stream) => {
            local.pipe(stream).pipe(local)
            stream.on('error', () => local.destroy())
            local.on('error', () => stream.destroy())
          })
          .catch(() => local.destroy())
      })
      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err)
      })
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        const boundPort = addr && typeof addr === 'object' ? addr.port : port
        resolve({ server, localPort: boundPort })
      })
    })
  try {
    return await tryListen(preferredLocalPort ?? 0)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE' && preferredLocalPort) {
      // Brief upstream said: pick a different random port and retry once.
      // `0` lets the OS pick, which is what we'd do for first-time
      // bootstrap anyway.
      return await tryListen(0)
    }
    throw Object.assign(new Error('failed to open local tunnel port'), {
      bootstrapError: {
        code: 'tunnel_failed',
        message: 'failed to open local tunnel port',
        detail: String(err)
      } satisfies BootstrapError
    })
  }
}

/** Drive the full bootstrap: connect → probe → (install) → start → tunnel.
 *  Caller (IPC handler) provides `callbacks` so progress events flow into
 *  the slice. On success, returns a `BootstrapResult` the caller hands to
 *  the tunnel manager + `connections:add`. On failure, throws an Error
 *  with `bootstrapError` attached so the handler can dispatch the typed
 *  error into the slice. */
export async function bootstrapRemote(
  target: SshTarget,
  callbacks: BootstrapCallbacks,
  opts: { preferredLocalPort?: number; skipInstallIfRunning?: boolean } = {}
): Promise<BootstrapResult> {
  const { NodeSSH } = loadNodeSsh()
  const ssh = new NodeSSH()
  const phase = (p: BootstrapPhase): void => callbacks.onPhase(p)
  const log = (line: string): void => callbacks.onLine(line)

  // --- 1. SSH connect ----------------------------------------------------
  phase('connecting')
  log(`connecting to ${target.raw} via ssh…`)
  try {
    // ssh2 does NOT parse ~/.ssh/config (unlike the `ssh` binary), so
    // we resolve User / Port / IdentityFile ourselves via our own
    // ssh-config parser. SSH_AUTH_SOCK is forwarded so agent-loaded
    // keys "just work" without the user copy-pasting an IdentityFile.
    const connectCfg = await resolveSshConnectConfig(target, log)
    await ssh.connect(connectCfg)
  } catch (err) {
    const bootstrapErr = asBootstrapError(err, {
      code: 'host_unreachable',
      message: `could not connect to ${target.host}`
    })
    try { ssh.dispose() } catch { /* ignore */ }
    throw Object.assign(new Error(bootstrapErr.message), { bootstrapError: bootstrapErr })
  }
  log('ssh connection established')

  // --- 2. Probe ----------------------------------------------------------
  phase('probing')
  try {
    const version = await probeServer(ssh)
    if (version) {
      log(`found existing harness-server ${version} on remote`)
    } else {
      log('harness-server not installed on remote')
      phase('installing')
      log('running install-headless.sh…')
      try {
        await runInstall(ssh, log)
      } catch (err) {
        const bootstrapErr =
          (err as { bootstrapError?: BootstrapError }).bootstrapError ??
          asBootstrapError(err, {
            code: 'install_failed',
            message: 'install failed'
          })
        try { ssh.dispose() } catch { /* ignore */ }
        throw Object.assign(new Error(bootstrapErr.message), { bootstrapError: bootstrapErr })
      }
      log('install complete')
    }

    // --- 3. Start (or reuse) ---------------------------------------------
    phase('starting')
    let state = await readRemoteState(ssh)
    if (state && opts.skipInstallIfRunning && (await isPidAlive(ssh, state.pid))) {
      log(`reusing running server (pid ${state.pid}, port ${state.port})`)
    } else if (state && (await isPidAlive(ssh, state.pid))) {
      log(`reusing running server (pid ${state.pid}, port ${state.port})`)
    } else {
      if (state) log(`previous server pid ${state.pid} is dead; starting fresh`)
      try {
        state = await startServerDetached(ssh, log)
      } catch (err) {
        const bootstrapErr =
          (err as { bootstrapError?: BootstrapError }).bootstrapError ??
          asBootstrapError(err, {
            code: 'server_start_failed',
            message: 'failed to start harness-server'
          })
        try { ssh.dispose() } catch { /* ignore */ }
        throw Object.assign(new Error(bootstrapErr.message), { bootstrapError: bootstrapErr })
      }
    }

    // --- 4. Tunnel -------------------------------------------------------
    phase('tunneling')
    log(`opening local→remote tunnel to 127.0.0.1:${state.port}…`)
    let tunnel: { server: NetServer; localPort: number }
    try {
      tunnel = await openTunnel(ssh, state.port, opts.preferredLocalPort)
    } catch (err) {
      const bootstrapErr =
        (err as { bootstrapError?: BootstrapError }).bootstrapError ??
        asBootstrapError(err, {
          code: 'tunnel_failed',
          message: 'failed to open local tunnel port'
        })
      try { ssh.dispose() } catch { /* ignore */ }
      throw Object.assign(new Error(bootstrapErr.message), { bootstrapError: bootstrapErr })
    }
    log(`tunnel live on localhost:${tunnel.localPort}`)
    phase('connected')
    return {
      localPort: tunnel.localPort,
      token: state.token,
      ssh,
      tunnelServer: tunnel.server,
      remotePort: state.port
    }
  } catch (err) {
    // Any failure not already typed gets a generic "unknown" wrapper so
    // the renderer still gets structured shape. Cleanup of ssh is the
    // responsibility of each step's catch above.
    if ((err as { bootstrapError?: BootstrapError }).bootstrapError) throw err
    const fallback: BootstrapError = {
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err)
    }
    try { ssh.dispose() } catch { /* ignore */ }
    throw Object.assign(new Error(fallback.message), { bootstrapError: fallback })
  }
}

/** Generate a fresh bootstrap id. Exported so the IPC handler doesn't
 *  need to know we're using uuid v4. */
export function newBootstrapId(): string {
  return randomUUID()
}
