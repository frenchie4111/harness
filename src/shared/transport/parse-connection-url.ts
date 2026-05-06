// Normalizes a backend-connection URL pasted by the user into the
// (wsUrl, token) pair the WebSocketClientTransport constructor expects.
//
// Accepts http/https (the schemes Settings shows in the UI today —
// the WS transport and the HTTP web-client share a port) plus ws/wss
// for users who already know the wire protocol. Maps:
//   http  → ws
//   https → wss
//   ws / wss → unchanged
// The `token` query parameter is required; it's extracted from the URL
// and returned separately so the URL we persist + show in chrome
// doesn't expose the secret.

export interface ParsedConnection {
  /** Schemeless authority + path with token stripped. Persisted in
   *  config.json on the BackendConnection.url field; never includes
   *  the token (which lives in secrets.enc). */
  storedUrl: string
  /** ws:// or wss:// URL with token stripped — what
   *  WebSocketClientTransport's `url` argument wants. */
  wsUrl: string
  /** Auth token, kept separate from the URL. */
  token: string
}

export type ParseResult =
  | { ok: true; parsed: ParsedConnection }
  | { ok: false; error: string }

export function parseConnectionUrl(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, error: 'Paste the connection link from the host machine.' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return {
      ok: false,
      error: 'Could not parse URL. Expected `http://host:port/?token=...`.'
    }
  }
  let wsProtocol: 'ws:' | 'wss:'
  switch (url.protocol) {
    case 'http:':
    case 'ws:':
      wsProtocol = 'ws:'
      break
    case 'https:':
    case 'wss:':
      wsProtocol = 'wss:'
      break
    default:
      return {
        ok: false,
        error: `Unsupported protocol "${url.protocol}". Use http, https, ws, or wss.`
      }
  }
  const token = url.searchParams.get('token')
  if (!token) {
    return {
      ok: false,
      error: 'URL is missing the `token` query parameter.'
    }
  }
  url.searchParams.delete('token')
  const wsUrl = wsProtocol + '//' + url.host + url.pathname + (url.search || '')
  // The persisted url keeps the ws/wss protocol so reconnection at
  // boot can rebuild the same wire URL without losing the TLS choice
  // (https → wss). Display surfaces strip the protocol when desired.
  const storedUrl = wsUrl
  return { ok: true, parsed: { storedUrl, wsUrl, token } }
}

/** Suggest a label from a parsed URL — host minus port, capped to a
 *  reasonable display width. Used as the default in the add-backend
 *  modal (overrideable by the user). */
export function suggestLabelFromUrl(parsed: ParsedConnection): string {
  // Strip protocol (ws:// or wss://) and port + path for the
  // hostname-derived guess.
  const noScheme = parsed.storedUrl.replace(/^wss?:\/\//, '')
  const host = noScheme.split('/')[0].split(':')[0]
  if (!host) return 'Backend'
  // localhost/127.0.0.1 → "Backend" (the user can rename); otherwise
  // use the first dotted segment, capped to 24 chars.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'Backend'
  const first = host.split('.')[0]
  return first.length > 24 ? first.slice(0, 24) : first
}
