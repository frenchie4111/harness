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
    '<!doctype html><html><head><title>t</title></head><body>ok</body></html>'
  )
  writeFileSync(join(root, 'app.js'), 'console.log("hi")')
  writeFileSync(join(root, 'favicon.ico'), 'fake-icon')

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
})
