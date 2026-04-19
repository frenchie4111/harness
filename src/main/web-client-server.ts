// HTTP server that serves the bundled web-client renderer to remote
// browsers. Designed to share its port with the WS transport: clients
// fetch `http://host:port/` to load index.html, then the renderer opens
// `ws://host:port/?token=…` on the same origin. Same-origin avoids any
// CORS plumbing, and the ws library's `verifyClient` still gates every
// upgrade on the shared auth token.
//
// The auth token is NOT served over any unauthenticated endpoint — it's
// injected into index.html at request time via a <meta> tag the renderer
// reads at boot. Anyone who can GET `/` already has the token; anyone
// who can't won't get one.
//
// Threat model: binding to 127.0.0.1 is effectively unauthenticated in
// practice (local users can read the token from the running process).
// Binding to 0.0.0.0 exposes to the LAN — the 32-byte token is the only
// thing between an untrusted LAN peer and the main process. No TLS yet;
// only enable LAN bind on a trusted network.

import { createServer, type Server as HttpServer } from 'http'
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
  '.map': 'application/json'
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

      const ext = extname(pathname).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      if (filePath === indexPath) {
        const injected = content
          .toString('utf-8')
          .replace(
            '</head>',
            `    <meta name="harness-ws-token" content="${escapeAttr(opts.token)}">\n  </head>`
          )
        res.end(injected)
        return
      }
      res.end(content)
    } catch (err) {
      log('web-client', 'http error', err instanceof Error ? err.message : String(err))
      res.statusCode = 500
      res.end('server error')
    }
  })
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
