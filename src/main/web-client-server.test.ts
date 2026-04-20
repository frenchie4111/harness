import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AddressInfo } from 'net'
import { createWebClientServer } from './web-client-server'

const TOKEN = 'secret-abc'

let root: string
let server: ReturnType<typeof createWebClientServer>
let port: number

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'web-client-test-'))
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>t</title>' +
      '<link rel="manifest" href="./manifest.webmanifest" />' +
      '</head><body>ok</body></html>'
  )
  writeFileSync(join(root, 'app.js'), 'console.log("hi")')
  writeFileSync(join(root, 'favicon.ico'), 'fake-icon')
  writeFileSync(
    join(root, 'manifest.webmanifest'),
    JSON.stringify({ name: 'Harness', start_url: '.', display: 'standalone' })
  )

  server = createWebClientServer({ token: TOKEN, rootDir: root })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

describe('createWebClientServer', () => {
  it('returns 401 for HTML entry without a token', async () => {
    const res = await fetch(url('/'))
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).not.toContain(TOKEN)
    expect(body).not.toContain('<html')
    expect(body).toMatch(/unauthorized/i)
  })

  it('returns 401 for /index.html without a token', async () => {
    const res = await fetch(url('/index.html'))
    expect(res.status).toBe(401)
  })

  it('returns 401 for HTML entry with the wrong token', async () => {
    const res = await fetch(url('/?token=nope'))
    expect(res.status).toBe(401)
  })

  it('serves HTML entry with a correct ?token=', async () => {
    const res = await fetch(url(`/?token=${TOKEN}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain('<html')
    expect(body).not.toContain('harness-ws-token')
  })

  it('accepts a bearer token in the Authorization header', async () => {
    const res = await fetch(url('/'), {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
  })

  it('serves static assets without a token', async () => {
    const js = await fetch(url('/app.js'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toMatch(/javascript/)

    const ico = await fetch(url('/favicon.ico'))
    expect(ico.status).toBe(200)
  })

  it('returns 404 for unknown assets', async () => {
    const res = await fetch(url('/does-not-exist.js'))
    expect(res.status).toBe(404)
  })

  it('rewrites manifest link in HTML to carry the token', async () => {
    const res = await fetch(url(`/?token=${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(
      `<link rel="manifest" href="./manifest.webmanifest?token=${encodeURIComponent(TOKEN)}" />`
    )
    expect(body).not.toContain('href="./manifest.webmanifest"')
  })

  it('URL-encodes tokens with special chars in the manifest link', async () => {
    const specialRoot = mkdtempSync(join(tmpdir(), 'web-client-test-'))
    writeFileSync(
      join(specialRoot, 'index.html'),
      '<!doctype html><html><head>' +
        '<link rel="manifest" href="./manifest.webmanifest" />' +
        '</head><body>ok</body></html>'
    )
    const specialToken = 'tok en&with/special?chars'
    const s = createWebClientServer({ token: specialToken, rootDir: specialRoot })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const p = (s.address() as AddressInfo).port
    const res = await fetch(
      `http://127.0.0.1:${p}/?token=${encodeURIComponent(specialToken)}`
    )
    const body = await res.text()
    expect(body).toContain(
      `./manifest.webmanifest?token=${encodeURIComponent(specialToken)}`
    )
    expect(body).not.toContain(specialToken)
    await new Promise<void>((r) => s.close(() => r()))
    rmSync(specialRoot, { recursive: true, force: true })
  })

  it('serves dynamic manifest with token-bearing start_url when authorized', async () => {
    const res = await fetch(url(`/manifest.webmanifest?token=${TOKEN}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/manifest\+json/)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.start_url).toBe(`./?token=${encodeURIComponent(TOKEN)}`)
    expect(body.name).toBe('Harness')
  })

  it('accepts bearer token for dynamic manifest', async () => {
    const res = await fetch(url('/manifest.webmanifest'), {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.start_url).toBe(`./?token=${encodeURIComponent(TOKEN)}`)
  })

  it('serves static manifest as-is when no token is presented', async () => {
    const res = await fetch(url('/manifest.webmanifest'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.start_url).toBe('.')
  })
})
