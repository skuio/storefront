/**
 * Password hashing on WebCrypto PBKDF2-HMAC-SHA256, so the same code runs on
 * Workers and in Node. The stored string carries every parameter:
 *
 *   $pbkdf2-sha256$i=<iterations>$<salt base64url>$<hash base64url>
 *
 * so the cost can be raised later and old hashes keep verifying (and can be
 * re-hashed on the next successful sign-in).
 */
const encoder = new TextEncoder()

/**
 * Cloudflare Workers cap a single PBKDF2 call at 100_000 iterations
 * (`NotSupportedError: iteration counts above 100000 are not supported`), which
 * Node does not — a gap that only shows up on the deployed Worker. To keep an
 * effective work factor above the OWASP-era 200k floor while staying under that
 * ceiling, the derivation is CHAINED: each 100k-iteration round feeds the next,
 * so a stored count of 300_000 is three rounds. The count must be a multiple of
 * the per-call cap.
 */
export const PBKDF2_MAX_PER_CALL = 100_000
export const PASSWORD_ITERATIONS = 300_000
const SALT_BYTES = 16
const HASH_BYTES = 32
export const PASSWORD_MIN_LENGTH = 12

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pbkdf2(material: BufferSource, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, HASH_BYTES * 8)
}

/**
 * PBKDF2 chained in <=100k-iteration rounds so the total honours `iterations`
 * without any single call exceeding the Workers cap. Each round's output is the
 * next round's input; the salt is constant. Node and Workers agree round for round.
 */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  let material: BufferSource = encoder.encode(password.normalize('NFKC'))
  let remaining = iterations
  while (remaining > 0) {
    const step = Math.min(remaining, PBKDF2_MAX_PER_CALL)
    material = await pbkdf2(material, salt, step)
    remaining -= step
  }
  return new Uint8Array(material as ArrayBuffer)
}

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)
  const hash = await derive(password, salt, iterations)
  return `$pbkdf2-sha256$i=${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`
}

export interface PasswordCheck {
  ok: boolean
  /** True when the stored hash uses fewer iterations than the current default. */
  needsRehash: boolean
}

/** Verify against a stored hash. Never throws on a malformed hash — it simply fails. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<PasswordCheck> {
  const match = /^\$pbkdf2-sha256\$i=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored ?? '')
  if (!match) return { ok: false, needsRehash: false }
  const iterations = Number(match[1])
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 10_000_000) return { ok: false, needsRehash: false }
  const salt = fromBase64Url(match[2]!)
  const expected = fromBase64Url(match[3]!)
  const actual = await derive(password, salt, iterations)
  if (actual.length !== expected.length) return { ok: false, needsRehash: false }
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!
  return { ok: diff === 0, needsRehash: iterations < PASSWORD_ITERATIONS }
}

/** The one rule the store enforces on a new password. Length, not composition. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (password.length > 256) return 'must be at most 256 characters'
  return null
}
