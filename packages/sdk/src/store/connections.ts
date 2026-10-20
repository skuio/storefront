import { parseJson, type StoreContext } from './context'
import { newId, randomBase64Url, randomToken, sha256Hex } from './crypto'
import { StoreError } from './errors'
import { RateLimiter } from './ratelimit'

export const CONNECT_CODE_MINUTES = 10
export const API_KEY_PREFIX = 'sk_store_'
/**
 * Operations systems the store can name on its approval screen. Any other
 * client id may connect too — an ERP, an OMS, a script — because nothing is
 * granted until the owner approves the request in /admin/connect, which shows
 * the client, the account and the exact host the browser returns to.
 */
export const KNOWN_CONNECT_CLIENTS: Readonly<Record<string, string>> = { skuio: 'SKU.io' }
/** @deprecated Every well-formed client id is accepted; see KNOWN_CONNECT_CLIENTS. */
export const CONNECT_CLIENT_IDS = Object.keys(KNOWN_CONNECT_CLIENTS) as readonly string[]
const CLIENT_ID = /^[a-z0-9][a-z0-9._-]{1,62}$/

/** The display name for a client id: a known system's name, else the id itself. */
export function connectClientName(clientId: string): string {
  return KNOWN_CONNECT_CLIENTS[clientId] ?? clientId
}
export const CONNECT_SCOPES = ['orders', 'payments', 'fulfillments', 'inventory', 'catalog'] as const
export type ConnectScope = (typeof CONNECT_SCOPES)[number]

export const SCOPE_DESCRIPTIONS: Record<ConnectScope, string> = {
  orders: 'Read orders, stamp its own order number on them and cancel them',
  payments: 'Mark orders paid, refunded or failed (for payments taken outside this store)',
  fulfillments: 'Push shipments and tracking to orders',
  inventory: 'Update available stock',
  catalog: 'Read and update products and categories',
}

export interface Connection {
  id: string
  name: string
  tenant: string | null
  redirectHost: string | null
  scopes: ConnectScope[]
  keyPrefix: string | null
  createdByOwnerId: string | null
  createdAt: string
  issuedAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface AuthorizeParams {
  client_id?: string | null
  redirect_uri?: string | null
  state?: string | null
  tenant?: string | null
  scope?: string | null
}

/** A validated connect request, ready to show the owner. */
export interface AuthorizeRequest {
  clientId: string
  /** Display name: "SKU.io" for skuio, else the client id. */
  clientName: string
  redirectUri: string
  redirectHost: string
  state: string
  tenant: string
  scopes: ConnectScope[]
}

export interface IssuedKey {
  apiKey: string
  connection: Connection
}

interface ConnectionRow {
  id: string
  name: string
  tenant: string | null
  redirect_host: string | null
  scopes_json: string
  key_hash: string | null
  key_prefix: string | null
  created_by_owner_id: string | null
  created_at: string
  issued_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  name: r.name,
  tenant: r.tenant,
  redirectHost: r.redirect_host,
  scopes: parseJson<string[]>(r.scopes_json, []).filter((s): s is ConnectScope => (CONNECT_SCOPES as readonly string[]).includes(s)),
  keyPrefix: r.key_prefix,
  createdByOwnerId: r.created_by_owner_id,
  createdAt: r.created_at,
  issuedAt: r.issued_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
})

/** http is allowed only where TLS cannot exist: a developer's machine. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.test')
}

/**
 * Consumers the owner approved. The store is the authorization server: an
 * owner approves a request in the browser, the consumer trades the resulting
 * one-time code for a per-connection API key, and only the key's SHA-256 is
 * ever stored. Revoking a connection turns its key into a 401.
 */
export class ConnectionsService {
  private readonly limiter: RateLimiter

  constructor(private readonly ctx: StoreContext) {
    this.limiter = new RateLimiter(ctx, { maxFailures: 20, windowMinutes: 15, lockMinutes: 15 })
  }

  /** Validate the query of a connect request. Throws `validation_failed` with a field per problem. */
  validateAuthorize(params: AuthorizeParams): AuthorizeRequest {
    const details: Record<string, string> = {}
    const clientId = (params.client_id ?? '').trim()
    if (!CLIENT_ID.test(clientId)) details.client_id = 'must be 2-63 lowercase letters, digits, dots, dashes or underscores'
    const state = (params.state ?? '').trim()
    if (!state) details.state = 'is required'
    else if (state.length > 1024) details.state = 'must be at most 1024 characters'
    const tenant = (params.tenant ?? '').trim()
    if (!tenant) details.tenant = 'is required'
    else if (tenant.length > 120) details.tenant = 'must be at most 120 characters'

    let redirect: URL | null = null
    const raw = (params.redirect_uri ?? '').trim()
    if (!raw) details.redirect_uri = 'is required'
    else {
      try {
        redirect = new URL(raw)
      } catch {
        details.redirect_uri = 'must be an absolute URL'
      }
    }
    if (redirect) {
      if (redirect.hash) details.redirect_uri = 'must not carry a fragment'
      else if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && isLocalHost(redirect.hostname))) details.redirect_uri = 'must use https'
      else if (redirect.username || redirect.password) details.redirect_uri = 'must not carry credentials'
    }

    const scopeRaw = (params.scope ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    const scopes = [...new Set(scopeRaw)] as string[]
    const unknown = scopes.filter((s) => !(CONNECT_SCOPES as readonly string[]).includes(s))
    if (!scopes.length) details.scope = 'is required'
    else if (unknown.length) details.scope = `unknown scope: ${unknown.join(', ')}`

    if (Object.keys(details).length) throw new StoreError('validation_failed', 'Invalid connect request', details)
    return { clientId, clientName: connectClientName(clientId), redirectUri: redirect!.href, redirectHost: redirect!.host, state, tenant, scopes: scopes as ConnectScope[] }
  }

  /** The owner said yes: create the connection and a one-time code. Returns the URL to send the browser to. */
  async approve(request: AuthorizeRequest, ownerId: string | null): Promise<{ connection: Connection; code: string; redirectTo: string }> {
    const now = this.ctx.now()
    const id = newId('con')
    const code = randomToken(32)
    const expiresAt = new Date(new Date(now).getTime() + CONNECT_CODE_MINUTES * 60_000).toISOString()
    const name = `${request.tenant} on ${request.clientName}`
    await this.ctx.db.batch([
      this.ctx.db
        .prepare(`INSERT INTO connections (id, name, tenant, redirect_host, scopes_json, created_by_owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, name, request.tenant, request.redirectHost, JSON.stringify(request.scopes), ownerId, now),
      this.ctx.db
        .prepare(`INSERT INTO connect_codes (code_hash, connection_id, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(await sha256Hex(code), id, request.redirectUri, expiresAt, now),
    ])
    const connection = (await this.byId(id))!
    return { connection, code, redirectTo: withQuery(request.redirectUri, { code, state: request.state }) }
  }

  /** The owner said no. */
  denyUrl(request: AuthorizeRequest): string {
    return withQuery(request.redirectUri, { error: 'access_denied', state: request.state })
  }

  /**
   * Trade a code for the connection's key. Exactly once: the code is marked used
   * in the same batch that stores the key hash, so a replay finds it used.
   * `address` keys the failure counter.
   */
  async exchange(input: { code?: unknown; redirect_uri?: unknown }, address: string): Promise<IssuedKey> {
    const limitKey = `token:${address}`
    await this.limiter.assertAllowed(limitKey, 'Too many failed exchanges. Try again in a few minutes.')
    const fail = async (message: string) => {
      await this.limiter.recordFailure(limitKey)
      return new StoreError('invalid_grant', message)
    }
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    const redirectUri = typeof input.redirect_uri === 'string' ? input.redirect_uri.trim() : ''
    if (!code || !redirectUri) throw await fail('code and redirect_uri are required')
    const now = this.ctx.now()
    const codeHash = await sha256Hex(code)
    const row = await this.ctx.db
      .prepare(`SELECT connection_id, redirect_uri, expires_at, used_at FROM connect_codes WHERE code_hash = ?`)
      .bind(codeHash)
      .first<{ connection_id: string; redirect_uri: string; expires_at: string; used_at: string | null }>()
    if (!row || row.used_at || row.expires_at <= now) throw await fail('The code is unknown, used or expired')
    if (row.redirect_uri !== redirectUri) throw await fail('redirect_uri does not match the one the code was issued for')
    const existing = await this.byId(row.connection_id)
    if (!existing || existing.revokedAt || existing.keyPrefix) throw await fail('The code is unknown, used or expired')

    const apiKey = `${API_KEY_PREFIX}${randomBase64Url(32)}`
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE connect_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`).bind(now, codeHash),
      this.ctx.db
        .prepare(`UPDATE connections SET key_hash = ?, key_prefix = ?, issued_at = ? WHERE id = ? AND key_hash IS NULL`)
        .bind(await sha256Hex(apiKey), apiKey.slice(0, API_KEY_PREFIX.length + 8), now, row.connection_id),
      this.limiter.clearStatement(limitKey),
    ])
    const connection = (await this.byId(row.connection_id))!
    if (!connection.keyPrefix) throw await fail('The code is unknown, used or expired')
    return { apiKey, connection }
  }

  /** The live connection behind a bearer key, or null. Bumps last_used_at at most once a minute. */
  async resolveKey(bearer: string): Promise<Connection | null> {
    if (!bearer.startsWith(API_KEY_PREFIX)) return null
    const row = await this.ctx.db.prepare(`SELECT * FROM connections WHERE key_hash = ?`).bind(await sha256Hex(bearer)).first<ConnectionRow>()
    if (!row || row.revoked_at) return null
    const now = this.ctx.now()
    if (!row.last_used_at || new Date(now).getTime() - new Date(row.last_used_at).getTime() > 60_000) {
      await this.ctx.db.prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`).bind(now, row.id).run()
      row.last_used_at = now
    }
    return toConnection(row)
  }

  async byId(id: string): Promise<Connection | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM connections WHERE id = ?`).bind(id).first<ConnectionRow>()
    return row ? toConnection(row) : null
  }

  /** Every connection that was issued a key, newest first. Pending (never exchanged) ones are not listed. */
  async list(): Promise<Connection[]> {
    const { results } = await this.ctx.db.prepare(`SELECT * FROM connections WHERE key_hash IS NOT NULL ORDER BY created_at DESC`).all<ConnectionRow>()
    return results.map(toConnection)
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.ctx.db.prepare(`UPDATE connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(this.ctx.now(), id).run()
    return (result.meta?.changes ?? 0) > 0
  }

  /** Housekeeping: expired codes, connections whose code was never exchanged, stale limiter rows. */
  async prune(): Promise<void> {
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`DELETE FROM connect_codes WHERE expires_at <= ? OR used_at IS NOT NULL`).bind(now),
      this.ctx.db.prepare(`DELETE FROM connections WHERE key_hash IS NULL AND created_at <= ?`).bind(new Date(new Date(now).getTime() - CONNECT_CODE_MINUTES * 60_000).toISOString()),
      this.limiter.pruneStatement(),
    ])
  }
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.href
}
