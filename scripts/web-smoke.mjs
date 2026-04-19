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
// Validates: GET / returns HTML with the auth token inlined as a meta
// tag, and a referenced asset is reachable. Doesn't exercise the WS
// upgrade — see scripts/ws-smoke.mjs for that.

const target = process.argv[2]
const token = process.argv[3]
if (!target || !token) {
  console.error('usage: node scripts/web-smoke.mjs <host:port> <token>')
  process.exit(1)
}

const base = `http://${target}`
const indexUrl = `${base}/?token=${encodeURIComponent(token)}`

async function main() {
  const indexRes = await fetch(indexUrl)
  if (!indexRes.ok) {
    console.error('index fetch failed:', indexRes.status)
    process.exit(1)
  }
  const html = await indexRes.text()
  const meta = html.match(
    /<meta name="harness-ws-token" content="([^"]+)">/
  )
  if (!meta) {
    console.error('index.html missing inlined token meta tag')
    process.exit(1)
  }
  if (meta[1] !== token) {
    console.error('inlined token mismatch:', meta[1].slice(0, 8) + '…')
    process.exit(1)
  }
  console.log('index.html OK, token meta inlined and matches')

  // Pull the main bundle reference out of the HTML and try to GET it.
  const script = html.match(/src="(\.\/assets\/[^"]+)"/)
  if (!script) {
    console.warn('no asset reference found in index.html (maybe an empty bundle)')
    process.exit(0)
  }
  const assetUrl = `${base}/${script[1].replace(/^\.\//, '')}`
  const assetRes = await fetch(assetUrl)
  if (!assetRes.ok) {
    console.error('asset fetch failed:', assetUrl, assetRes.status)
    process.exit(1)
  }
  console.log('asset OK:', script[1])
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
