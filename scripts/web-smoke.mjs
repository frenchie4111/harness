#!/usr/bin/env node
// Manual smoke test for the web-client HTTP server.
//
// Usage:
//   1. Start Harness with the WS transport on:
//        HARNESS_WS_TRANSPORT=1 npm run dev
//      (optionally also HARNESS_WS_HOST=0.0.0.0 to bind LAN-wide)
//   2. Copy the URL the main process logs to stdout.
//   3. node scripts/web-smoke.mjs <host:port> <token>
//
// Validates:
//   - GET / without a token → 401, body does not contain the token.
//   - GET /?token=<token> → 200 HTML.
//   - A referenced asset is reachable (ungated by design).
// Doesn't exercise the WS upgrade — see scripts/ws-smoke.mjs for that.

const target = process.argv[2]
const token = process.argv[3]
if (!target || !token) {
  console.error('usage: node scripts/web-smoke.mjs <host:port> <token>')
  process.exit(1)
}

const base = `http://${target}`
const indexUrl = `${base}/?token=${encodeURIComponent(token)}`

async function main() {
  const unauthRes = await fetch(`${base}/`)
  if (unauthRes.status !== 401) {
    console.error('expected 401 for unauthenticated GET /, got', unauthRes.status)
    process.exit(1)
  }
  const unauthBody = await unauthRes.text()
  if (unauthBody.includes(token)) {
    console.error('unauthenticated response leaked the token')
    process.exit(1)
  }
  console.log('unauthenticated GET / → 401 (no token leak) OK')

  const indexRes = await fetch(indexUrl)
  if (!indexRes.ok) {
    console.error('authed index fetch failed:', indexRes.status)
    process.exit(1)
  }
  const html = await indexRes.text()
  if (!/<html/i.test(html)) {
    console.error('authed index response did not look like HTML')
    process.exit(1)
  }
  console.log('authed GET /?token=… → 200 HTML OK')

  const script = html.match(/src="(\.?\/?assets\/[^"]+)"/)
  if (!script) {
    console.warn('no asset reference found in index.html (maybe an empty bundle)')
    process.exit(0)
  }
  const assetPath = script[1].replace(/^\.\//, '').replace(/^\//, '')
  const assetUrl = `${base}/${assetPath}`
  const assetRes = await fetch(assetUrl)
  if (!assetRes.ok) {
    console.error('asset fetch failed:', assetUrl, assetRes.status)
    process.exit(1)
  }
  console.log('asset (ungated) OK:', assetPath)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
