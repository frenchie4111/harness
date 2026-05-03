// Pulled out of preload/index.ts so the parsing logic can be unit-tested
// without standing up an Electron preload context. The remote URL is
// passed to the BrowserWindow via webPreferences.additionalArguments
// (see desktop-shell-remote.ts), and arrives at the preload as a
// `--harness-remote-url=...` entry in `process.argv`.

const FLAG = '--harness-remote-url='

export function findRemoteUrl(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(FLAG)) {
      const value = arg.slice(FLAG.length)
      return value || null
    }
  }
  return null
}

/** Split a `ws://host:port?token=...` URL into the parts the
 *  WebSocketClientTransport constructor wants — the URL without the
 *  token query param, and the token itself. Returns null if the URL is
 *  unparseable. The token query param is optional: if absent, an empty
 *  string is returned and the server's auth check will reject the
 *  connection (which surfaces in the renderer error UI). */
export function splitRemoteUrl(raw: string): { url: string; token: string } | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const token = parsed.searchParams.get('token') ?? ''
  parsed.searchParams.delete('token')
  return { url: parsed.toString(), token }
}
