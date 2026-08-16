/** `crypto.randomUUID` is only exposed in secure contexts, so it's undefined
 *  in the web client whenever it's reached over plain http://<lan-ip>:<port>
 *  — which is the normal way a phone connects. `getRandomValues` has no such
 *  restriction, so fall back to minting the v4 by hand. IDs from here are fed
 *  to `claude --session-id`, which requires a well-formed UUID. */
export function randomUUID(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
