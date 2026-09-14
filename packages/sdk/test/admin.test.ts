import { describe, expect, it } from 'vitest'
import { handleStoreApi } from '../src/api'
import type { Store } from '../src/store'
import { hashPassword, verifyPassword, passwordProblem, PASSWORD_ITERATIONS, PBKDF2_MAX_PER_CALL } from '../src/store/password'
import { placeOrder, rig, seed } from './helpers'

const ENV_KEY = 'k'.repeat(64)
const PASSWORD = 'correct horse battery staple'

function client(store: Store, envKey: string | null = ENV_KEY) {
  return async (method: string, path: string, body?: unknown, key: string | null = envKey, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers }
    if (key !== null) h.authorization = `Bearer ${key}`
    if (body !== undefined) h['content-type'] = 'application/json'
    const request = new Request(`https://store.test/api/skuio/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    const response = await handleStoreApi(request, { store, apiKey: envKey ?? undefined })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}

const REQUEST = {
  client_id: 'skuio',
  redirect_uri: 'https://acme.sku.test/storefront/oauth/callback',
  state: 'abc123',
  tenant: 'acme',
  scope: 'orders,fulfillments,inventory,catalog',
}

async function owner(store: Store, email = 'owner@store.test') {
  return store.owners.upsert({ email, name: 'Store Owner', password: PASSWORD })
}

/** Run the browser half: owner approves, we pull the code off the redirect. */
async function approve(store: Store, ownerId: string | null = null) {
  const request = store.connections.validateAuthorize(REQUEST)
  const approved = await store.connections.approve(request, ownerId)
  const url = new URL(approved.redirectTo)
  return { ...approved, code: url.searchParams.get('code')!, state: url.searchParams.get('state'), url }
}

describe('passwords', () => {
  it('hashes with PBKDF2-SHA256, stores its parameters, and verifies in constant shape', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash).toMatch(/^\$pbkdf2-sha256\$i=300000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(await hashPassword(PASSWORD)).not.toBe(hash)
    expect(await verifyPassword(PASSWORD, hash)).toEqual({ ok: true, needsRehash: false })
    expect(await verifyPassword('wrong', hash)).toEqual({ ok: false, needsRehash: false })
    expect(await verifyPassword(PASSWORD, 'garbage')).toEqual({ ok: false, needsRehash: false })
    expect(await verifyPassword(PASSWORD, null)).toEqual({ ok: false, needsRehash: false })
  })

  it('flags hashes made with fewer iterations for a rehash', async () => {
    const weak = await hashPassword(PASSWORD, 50_000)
    expect(await verifyPassword(PASSWORD, weak)).toEqual({ ok: true, needsRehash: true })
    expect(PASSWORD_ITERATIONS).toBeGreaterThanOrEqual(200_000)
    // Workers cap a single PBKDF2 call at 100k; the effective count is reached by chaining.
    expect(PBKDF2_MAX_PER_CALL).toBeLessThanOrEqual(100_000)
    expect(PASSWORD_ITERATIONS % PBKDF2_MAX_PER_CALL).toBe(0)
  })

  it('only enforces length on a new password', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/)
    expect(passwordProblem('x'.repeat(300))).toMatch(/at most 256/)
    expect(passwordProblem('a perfectly fine passphrase')).toBeNull()
  })
})

describe('owners', () => {
  it('signs in with the right password, refuses the wrong one with the same null, and resolves the session', async () => {
    const { store } = rig({ SESSION_SECRET: 's' })
    const created = await owner(store)
    expect(created).toMatchObject({ email: 'owner@store.test', name: 'Store Owner', lastSignedInAt: null })

    expect(await store.owners.signIn('owner@store.test', 'nope', '1.1.1.1')).toBeNull()
    expect(await store.owners.signIn('nobody@store.test', PASSWORD, '1.1.1.1')).toBeNull()

    const session = await store.owners.signIn('Owner@Store.test ', PASSWORD, '1.1.1.1')
    expect(session).not.toBeNull()
    expect(session!.owner.lastSignedInAt).not.toBeNull()
    expect(await store.owners.resolve(session!.token)).toMatchObject({ id: created.id })
    expect(await store.owners.resolve('not-a-token')).toBeNull()

    await store.owners.signOut(session!.token)
    expect(await store.owners.resolve(session!.token)).toBeNull()
  })

  it('locks an email + address after ten failures and clears the counter on success', async () => {
    const { store, clock } = rig()
    await owner(store)
    for (let i = 0; i < 10; i++) expect(await store.owners.signIn('owner@store.test', 'nope', '9.9.9.9')).toBeNull()
    await expect(store.owners.signIn('owner@store.test', PASSWORD, '9.9.9.9')).rejects.toMatchObject({ code: 'rate_limited' })
    // A different address is not locked.
    expect(await store.owners.signIn('owner@store.test', PASSWORD, '8.8.8.8')).not.toBeNull()
    clock.tick(16 * 60_000)
    expect(await store.owners.signIn('owner@store.test', PASSWORD, '9.9.9.9')).not.toBeNull()
  })

  it('upsert on an existing email resets the password and ends nothing by itself', async () => {
    const { store } = rig()
    await owner(store)
    await store.owners.upsert({ email: 'owner@store.test', password: 'a brand new passphrase' })
    expect(await store.owners.signIn('owner@store.test', PASSWORD, '1.1.1.1')).toBeNull()
    expect(await store.owners.signIn('owner@store.test', 'a brand new passphrase', '1.1.1.1')).not.toBeNull()
    expect(await store.owners.count()).toBe(1)
    await expect(store.owners.upsert({ email: 'x@y.z', password: 'short' })).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('emails a single-use reset link that changes the password and ends every session', async () => {
    const { store, mail, clock } = rig()
    await owner(store)
    const session = (await store.owners.signIn('owner@store.test', PASSWORD, '1.1.1.1'))!

    expect(await store.owners.sendResetLink('nobody@store.test')).toBe(false)
    expect(await store.owners.sendResetLink('owner@store.test')).toBe(true)
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]!.to).toBe('owner@store.test')
    const token = /token=([0-9a-f]+)/.exec(mail.sent[0]!.text)![1]!
    expect(mail.sent[0]!.text).toContain('/admin/reset-password/?token=')

    await expect(store.owners.resetPassword(token, 'short')).rejects.toMatchObject({ code: 'validation_failed' })
    await store.owners.resetPassword(token, 'the replacement passphrase')
    expect(await store.owners.resolve(session.token)).toBeNull()
    expect(await store.owners.signIn('owner@store.test', 'the replacement passphrase', '1.1.1.1')).not.toBeNull()
    await expect(store.owners.resetPassword(token, 'another passphrase here')).rejects.toMatchObject({ code: 'not_found' })

    expect(await store.owners.sendResetLink('owner@store.test')).toBe(true)
    const second = /token=([0-9a-f]+)/.exec(mail.sent[1]!.text)![1]!
    clock.tick(31 * 60_000)
    await expect(store.owners.resetPassword(second, 'too late passphrase')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('sessions expire after fourteen days', async () => {
    const { store, clock } = rig()
    await owner(store)
    const session = (await store.owners.signIn('owner@store.test', PASSWORD, '1.1.1.1'))!
    clock.tick(13 * 86_400_000)
    expect(await store.owners.resolve(session.token)).not.toBeNull()
    clock.tick(2 * 86_400_000)
    expect(await store.owners.resolve(session.token)).toBeNull()
  })
})

describe('connect: authorize', () => {
  it('validates the request and names each problem', () => {
    const { store } = rig()
    const v = (p: Partial<typeof REQUEST>) => {
      try {
        store.connections.validateAuthorize({ ...REQUEST, ...p })
        return null
      } catch (e) {
        return (e as { details: Record<string, string> }).details
      }
    }
    expect(v({})).toBeNull()
    expect(v({ redirect_uri: '' })).toMatchObject({ redirect_uri: 'is required' })
    expect(v({ redirect_uri: 'http://sku.example.com/cb' })).toMatchObject({ redirect_uri: 'must use https' })
    expect(v({ redirect_uri: 'https://sku.example.com/cb#frag' })).toMatchObject({ redirect_uri: 'must not carry a fragment' })
    expect(v({ redirect_uri: 'not a url' })).toMatchObject({ redirect_uri: 'must be an absolute URL' })
    expect(v({ redirect_uri: 'http://localhost:8000/cb' })).toBeNull()
    expect(v({ redirect_uri: 'http://acme.sku.test/cb' })).toBeNull()
    expect(v({ client_id: 'someone-else' })).toMatchObject({ client_id: 'is not a known consumer' })
    expect(v({ scope: 'orders,launch_codes' })).toMatchObject({ scope: 'unknown scope: launch_codes' })
    expect(v({ scope: '' })).toMatchObject({ scope: 'is required' })
    expect(v({ state: '' })).toMatchObject({ state: 'is required' })
    expect(v({ tenant: '' })).toMatchObject({ tenant: 'is required' })
  })

  it('normalises the request: host, de-duplicated scopes, opaque state echoed untouched', () => {
    const { store } = rig()
    const req = store.connections.validateAuthorize({ ...REQUEST, scope: 'orders orders, catalog', state: 'a=b&c=d' })
    expect(req).toMatchObject({ redirectHost: 'acme.sku.test', scopes: ['orders', 'catalog'], state: 'a=b&c=d', tenant: 'acme' })
    expect(store.connections.denyUrl(req)).toBe('https://acme.sku.test/storefront/oauth/callback?error=access_denied&state=a%3Db%26c%3Dd')
  })

  it('approve keeps the redirect URI query and adds code + state', async () => {
    const { store } = rig()
    const req = store.connections.validateAuthorize({ ...REQUEST, redirect_uri: 'https://sku.example.com/cb?keep=1' })
    const approved = await store.connections.approve(req, null)
    const url = new URL(approved.redirectTo)
    expect(url.origin + url.pathname).toBe('https://sku.example.com/cb')
    expect(url.searchParams.get('keep')).toBe('1')
    expect(url.searchParams.get('state')).toBe('abc123')
    expect(url.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/)
    expect(approved.connection).toMatchObject({ name: 'acme on SKU.io', tenant: 'acme', keyPrefix: null, revokedAt: null })
    // Pending connections are not listed until a key is issued.
    expect(await store.connections.list()).toEqual([])
  })
})

describe('connect: token exchange and keys', () => {
  it('issues a key exactly once and the key works on the API while the env key keeps working', async () => {
    const { store } = rig()
    await seed(store)
    await placeOrder(store)
    const me = await owner(store)
    const api = client(store)
    const { code } = await approve(store, me.id)

    const exchanged = await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null)
    expect(exchanged.status).toBe(201)
    const key = exchanged.body.data.api_key as string
    expect(key).toMatch(/^sk_store_[A-Za-z0-9_-]{43}$/)
    expect(exchanged.body.data.connection).toMatchObject({ name: 'acme on SKU.io', tenant: 'acme', scopes: ['orders', 'fulfillments', 'inventory', 'catalog'], key_prefix: key.slice(0, 17) })
    expect(JSON.stringify(exchanged.body)).not.toContain(code)

    const orders = await api('GET', '/orders', undefined, key)
    expect(orders.status).toBe(200)
    expect(orders.body.data).toHaveLength(1)

    const health = await api('GET', '/health', undefined, key)
    expect(health.body.data.connection).toMatchObject({ name: 'acme on SKU.io', tenant: 'acme' })
    expect(health.body.data.owner_configured).toBe(true)

    const envHealth = await api('GET', '/health')
    expect(envHealth.status).toBe(200)
    expect(envHealth.body.data.connection).toBeNull()

    const replay = await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null)
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe('invalid_grant')

    expect((await store.connections.list()).map((c) => c.keyPrefix)).toEqual([key.slice(0, 17)])
  })

  it('rejects a wrong redirect_uri, an expired code, an unknown code and a malformed body', async () => {
    const { store, clock } = rig()
    const api = client(store)
    const { code } = await approve(store)
    const wrong = await api('POST', '/connect/token', { code, redirect_uri: 'https://acme.sku.test/elsewhere' }, null)
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toMatchObject({ code: 'invalid_grant', message: expect.stringContaining('redirect_uri') })

    const unknown = await api('POST', '/connect/token', { code: 'f'.repeat(64), redirect_uri: REQUEST.redirect_uri }, null)
    expect(unknown.status).toBe(400)

    const malformed = await api('POST', '/connect/token', { redirect_uri: REQUEST.redirect_uri }, null)
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('invalid_grant')

    clock.tick(11 * 60_000)
    const late = await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null)
    expect(late.status).toBe(400)
    // The code the wrong redirect_uri was tried with is still unused — the right call after expiry is what fails, not the earlier miss.
    expect(await store.connections.list()).toEqual([])
  })

  it('locks an address after twenty failed exchanges', async () => {
    const { store } = rig()
    const api = client(store)
    for (let i = 0; i < 20; i++) {
      const r = await api('POST', '/connect/token', { code: 'e'.repeat(64), redirect_uri: REQUEST.redirect_uri }, null, { 'cf-connecting-ip': '5.5.5.5' })
      expect(r.status).toBe(400)
    }
    const { code } = await approve(store)
    const locked = await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null, { 'cf-connecting-ip': '5.5.5.5' })
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe('rate_limited')
    const other = await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null, { 'cf-connecting-ip': '6.6.6.6' })
    expect(other.status).toBe(201)
  })

  it('introspects and revokes a connection; a revoked key is a 401 from then on', async () => {
    const { store } = rig()
    const api = client(store)
    const { code } = await approve(store)
    const key = (await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null)).body.data.api_key as string

    const me = await api('GET', '/connect', undefined, key)
    expect(me.status).toBe(200)
    expect(me.body.data).toMatchObject({ tenant: 'acme', revoked_at: null })
    expect(me.body.data.last_used_at).not.toBeNull()

    expect((await api('GET', '/connect')).body.data).toBeNull()
    expect((await api('DELETE', '/connect')).status).toBe(409)

    expect((await api('DELETE', '/connect', undefined, key)).status).toBe(204)
    const after = await api('GET', '/health', undefined, key)
    expect(after.status).toBe(401)
    expect((await api('GET', '/health')).status).toBe(200)
    expect((await store.connections.list())[0]!.revokedAt).not.toBeNull()
  })

  it('refuses a store with no env key and no connections, and a lookalike key', async () => {
    const { store } = rig()
    const api = client(store, null)
    expect((await api('GET', '/health')).status).toBe(401)
    expect((await api('GET', '/health', undefined, 'sk_store_' + 'a'.repeat(43))).status).toBe(401)
    const { code } = await approve(store)
    const key = (await api('POST', '/connect/token', { code, redirect_uri: REQUEST.redirect_uri }, null)).body.data.api_key as string
    expect((await api('GET', '/health', undefined, key)).status).toBe(200)
  })

  it('prunes pending connections whose code was never exchanged', async () => {
    const { store, clock } = rig()
    await approve(store)
    clock.tick(11 * 60_000)
    await store.connections.prune()
    const row = await store.db.prepare(`SELECT COUNT(*) AS n FROM connections`).first<{ n: number }>()
    expect(row?.n).toBe(0)
  })
})
