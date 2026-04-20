// HTTP server that serves the bundled web-client renderer to remote
// browsers. Designed to share its port with the WS transport: clients
// fetch `http://host:port/?token=…` to load index.html, then the
// renderer opens `ws://host:port/?token=…` on the same origin.
// Same-origin avoids any CORS plumbing, and the ws library's
// `verifyClient` still gates every upgrade on the shared auth token.
//
// Auth model:
//   - HTML entry (`/`, `/index.html`) requires `?token=<token>` on the
//     URL (or an `Authorization: Bearer <token>` header). Unauthenticated
//     requests get 401 with a plaintext hint — the token is never
//     disclosed to a caller that didn't already present it.
//   - WS upgrade on the same port is gated by `verifyClient` against the
//     same token.
//   - Static assets (CSS, JS chunks, images, favicon, manifest, fonts)
//     are intentionally ungated: they don't carry the token, browsers
//     often fetch them without query strings (favicon/manifest), and
//     once the HTML entry is gated an attacker with no token has no way
//     to bootstrap a useful asset fetch in-context.
//
// Threat model: binding to 127.0.0.1 is effectively unauthenticated in
// practice (local users can read the token from the running process).
// Binding to 0.0.0.0 exposes to the LAN — the 32-byte token is the only
// thing between an untrusted LAN peer and the main process. No TLS yet;
// only enable LAN bind on a trusted network.
//
// PWA manifest injection: the static `manifest.webmanifest` on disk has
// `start_url: "."`, which would make iOS "Add to Home Screen" shortcuts
// open `/` with no token and hit the 401 gate. To fix this without
// leaking the token in the on-disk file, we do two things when serving
// an authenticated request:
//   - rewrite the `<link rel="manifest" href="…">` tag in index.html to
//     point at `./manifest.webmanifest?token=<token>`, so Safari fetches
//     the manifest with the token attached.
//   - respond to authenticated `/manifest.webmanifest` requests with a
//     JSON body whose `start_url` is `./?token=<token>`, so the home
//     screen shortcut inherits the token.
// Unauthenticated manifest requests fall through to the static file
// (start_url stays `.`), so a token is never disclosed to a caller that
// didn't already present one.

import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { readFile, stat } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { log } from './debug'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json'
}

export interface WebClientServerOptions {
  token: string
  rootDir: string
}

/** Build an http.Server that serves the web-client bundle. Caller is
 *  responsible for .listen(); the same server is also handed to the
 *  WebSocketServerTransport so the two share a port. */
export function createWebClientServer(opts: WebClientServerOptions): HttpServer {
  const root = resolve(opts.rootDir)
  const indexPath = join(root, 'index.html')
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '/' || pathname === '') pathname = '/index.html'

      const filePath = resolve(join(root, pathname))
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }

      const isHtmlEntry = filePath === indexPath
      const isManifest = pathname === '/manifest.webmanifest'
      if (isHtmlEntry && !hasValidToken(req, url, opts.token)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('unauthorized — append ?token=<token> to the URL')
        return
      }

      let content: Buffer | null = null
      try {
        const st = await stat(filePath)
        if (st.isFile()) content = await readFile(filePath)
      } catch {
        // fall through to 404 / SPA fallback below
      }

      if (!content) {
        if (pathname === '/index.html') {
          res.statusCode = 404
          res.end('web-client bundle not found — run `npm run build` first')
          return
        }
        // Asset miss: return 404 rather than falling back to index.html —
        // a /static/foo.js 404 surfaces build misconfig cleanly.
        res.statusCode = 404
        res.end('not found')
        return
      }

      if (isHtmlEntry) {
        const tokenEnc = encodeURIComponent(opts.token)
        const html = content
          .toString('utf8')
          .replace(
            /<link\s+rel=["']manifest["']\s+href=["'][^"']*["']\s*\/?>/,
            `<link rel="manifest" href="./manifest.webmanifest?token=${tokenEnc}" />`
          )
        res.setHeader('Content-Type', MIME['.html'])
        res.end(html)
        return
      }

      if (isManifest && hasValidToken(req, url, opts.token)) {
        try {
          const manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>
          manifest.start_url = `./?token=${encodeURIComponent(opts.token)}`
          res.setHeader('Content-Type', 'application/manifest+json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(manifest))
          return
        } catch {
          // fall through to serving the static manifest as-is
        }
      }

      const ext = extname(pathname).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      res.end(content)
    } catch (err) {
      log('web-client', 'http error', err instanceof Error ? err.message : String(err))
      res.statusCode = 500
      res.end('server error')
    }
  })
}

function hasValidToken(req: IncomingMessage, url: URL, expected: string): boolean {
  const q = url.searchParams.get('token')
  if (q && q === expected) return true
  const auth = req.headers['authorization']
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && m[1] === expected) return true
  }
  return false
}
