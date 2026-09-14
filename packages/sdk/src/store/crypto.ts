/**
 * Token and hashing helpers on WebCrypto, which both Workers and Node 20+ expose
 * as the global `crypto`.
 */
const encoder = new TextEncoder()

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Random id with a type prefix: ord_…, cus_…, ful_… */
export function newId(prefix: string, length = 20): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return `${prefix}_${out}`
}

/** Random secret token, hex. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return toHex(buf)
}

/** Random secret as URL-safe base64 (no padding); 32 bytes → 43 characters. */
export function randomBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input)))
}

/**
 * Hash a bearer token for storage. With a secret the hash is an HMAC, so a
 * copy of the database alone cannot be used to forge a session.
 */
export async function hashToken(token: string, secret?: string): Promise<string> {
  if (!secret) return sha256Hex(token)
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(token)))
}

/** Compare two secrets without leaking where they differ. Hashes first so lengths never leak either. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  return diff === 0
}
