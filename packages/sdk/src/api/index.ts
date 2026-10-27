import type { Connection, Store } from '../store'
import { API_KEY_PREFIX, type ConnectScope } from '../store/connections'
import { secretsEqual } from '../store/crypto'
import { StoreError } from '../store/errors'
import { serializeCategory, serializeFulfillment, serializeOrder, serializeProduct, serializeQuote, type ImageUrlResolver, type SerializeProductOptions } from './serialize'
import {
  validateCategories, validateFulfillment, validateInventory, validateListQuery, validateOrderPatch, validateProducts, validateQuotePatch, ValidationError,
} from './validate'

export interface StoreApiOptions {
  store: Store
  /**
   * The STORE_API_KEY secret — the break-glass key that works without an owner
   * or a connection. Optional: a store whose consumers all connect through the
   * owner-approved flow can leave it unset.
   */
  apiKey: string | undefined
  /** Where the API is mounted in the request URL. */
  basePath?: string
  /**
   * Maps a stored product image src (a bare filename, a path, or an absolute
   * URL) to the absolute URL the store actually serves it at — e.g. the
   * fingerprinted `/_astro/<name>.<hash>.jpg` a template's `resolveImage()`
   * finds, made absolute against the site URL. Return null to fall back to the
   * default: an absolute src as-is, a relative one resolved against the
   * request origin. `images[].url` in every response is always absolute.
   */
  imageUrl?: ImageUrlResolver
}

/** Who a request authenticated as: the environment key, or an approved connection. */
export type ApiCaller = { kind: 'env' } | { kind: 'connection'; connection: Connection }

/**
 * Where the Store API is served. `/api/store/v1` is the neutral path for any
 * operations system; `/api/skuio/v1` is the original path SKU.io's Storefront
 * integration calls, kept for good. Same handler, same keys, same responses.
 */
export const STORE_API_BASES = ['/api/store/v1', '/api/skuio/v1'] as const
/** @deprecated The SKU.io path; use STORE_API_BASES. */
export const STORE_API_BASE = '/api/skuio/v1'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

const error = (status: number, code: string, message: string, details: Record<string, string> | null = null) =>
  json({ error: { code, message, details } }, status)

/**
 * The Store API (`docs/store-api.md`) as one fetch-style handler. Mount it on
 * a catch-all route under `/api/store/v1` (and `/api/skuio/v1`, the path SKU.io
 * calls) and hand it every method.
 */
export async function handleStoreApi(request: Request, options: StoreApiOptions): Promise<Response> {
  const url = new URL(request.url)
  const bases = options.basePath ? [options.basePath] : [...STORE_API_BASES]
  const base = bases.map((b) => b.replace(/\/+$/, '')).find((b) => url.pathname.includes(b))
  if (!base) return error(404, 'not_found', 'No such endpoint')
  const at = url.pathname.indexOf(base)
  const path = url.pathname.slice(at + base.length).replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()

  try {
    // The token exchange is the one unauthenticated endpoint: the code is the credential.
    if (path === '/connect/token' && method === 'POST') {
      const issued = await options.store.connections.exchange(await readJson(request), clientAddress(request))
      return json({ data: { api_key: issued.apiKey, connection: serializeConnection(issued.connection) } }, 201)
    }

    const caller = await authorized(request, options.apiKey, options.store)
    if (!caller) return error(401, 'unauthorized', 'A valid bearer key is required: a connection key issued through /admin/connect, or the STORE_API_KEY secret')

    // A connection may use only what the owner approved; the STORE_API_KEY secret may use everything.
    const scope = scopeFor(path)
    if (scope && caller.kind === 'connection' && !caller.connection.scopes.includes(scope)) {
      return error(403, 'forbidden', `This connection was not approved for "${scope}"; reconnect and approve it at /admin/connect`)
    }

    const images: SerializeProductOptions = { imageUrl: options.imageUrl, origin: url.origin }
    return await route(method, path, url, request, options.store, caller, images)
  } catch (e) {
    if (e instanceof ValidationError) return error(422, 'validation_failed', e.message, e.details)
    if (e instanceof StoreError) return error(e.status, e.code, e.message, e.details)
    console.error('store api: unhandled error', e)
    return error(500, 'internal_error', 'The store could not complete the request')
  }
}

async function authorized(request: Request, apiKey: string | undefined, store: Store): Promise<ApiCaller | null> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const bearer = match[1]!.trim()
  if (bearer.startsWith(API_KEY_PREFIX)) {
    const connection = await store.connections.resolveKey(bearer)
    return connection ? { kind: 'connection', connection } : null
  }
  if (apiKey && (await secretsEqual(bearer, apiKey))) return { kind: 'env' }
  return null
}

/** The caller's address for failure counting; Cloudflare sets the first header, proxies the second. */
function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export function serializeConnection(c: Connection) {
  return {
    id: c.id,
    name: c.name,
    tenant: c.tenant,
    scopes: c.scopes,
    key_prefix: c.keyPrefix,
    created_at: c.createdAt,
    issued_at: c.issuedAt,
    last_used_at: c.lastUsedAt,
    revoked_at: c.revokedAt,
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text.trim()) throw new ValidationError('Request body must be JSON', { body: 'is empty' })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ValidationError('Request body must be JSON', { body: 'is not valid JSON' })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError('Request body must be a JSON object', { body: 'is not an object' })
  return parsed as Record<string, unknown>
}

/**
 * The scope an endpoint needs. There is deliberately no endpoint that creates
 * an order: orders come only from the store's own checkout, priced from its
 * database, or from a buyer accepting a quote, so a leaked key cannot invent
 * sales. A key with `quotes` can price a quote; only the buyer turns it into
 * an order.
 */
function scopeFor(path: string): ConnectScope | null {
  const first = path.split('/').filter(Boolean)[0]
  if (first === 'orders') return /^\/orders\/[^/]+\/fulfillments$/.test(path) ? 'fulfillments' : 'orders'
  if (first === 'inventory') return 'inventory'
  if (first === 'products' || first === 'categories') return 'catalog'
  if (first === 'quotes') return 'quotes'
  return null // /health, /connect
}

async function route(method: string, path: string, url: URL, request: Request, store: Store, caller: ApiCaller, images: SerializeProductOptions): Promise<Response> {
  const segments = path.split('/').filter(Boolean)

  if (path === '/health' && method === 'GET') {
    const health = await store.health()
    const connection = caller.kind === 'connection' ? { id: caller.connection.id, name: caller.connection.name, tenant: caller.connection.tenant } : null
    return json({ data: { ...health, connection } })
  }

  if (path === '/connect') {
    if (method === 'GET') return json({ data: caller.kind === 'connection' ? serializeConnection(caller.connection) : null })
    if (method === 'DELETE') {
      if (caller.kind !== 'connection') return error(409, 'conflict', 'The STORE_API_KEY secret is not a connection; rotate it on the Worker instead')
      await store.connections.revoke(caller.connection.id)
      return new Response(null, { status: 204 })
    }
  }

  if (segments[0] === 'orders') {
    if (segments.length === 1 && method === 'GET') {
      const updatedSince = url.searchParams.get('updated_since')
      const cursor = url.searchParams.get('cursor')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw ? Number(limitRaw) : 50
      if (limitRaw && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ValidationError('Invalid query', { limit: 'must be an integer from 1 to 200' })
      if (updatedSince && Number.isNaN(Date.parse(updatedSince))) throw new ValidationError('Invalid query', { updated_since: 'must be an ISO-8601 timestamp' })
      // Lazy housekeeping: abandoned processor checkouts become cancelled before the consumer sees the list.
      await store.orders.expireAbandoned()
      const page = await store.orders.changedSince(updatedSince ? new Date(updatedSince).toISOString() : null, cursor, limit)
      return json({ data: page.orders.map((o) => serializeOrder(o, store.config.orders.numberPrefix)), next_cursor: page.nextCursor })
    }
    const id = segments[1] ? decodeURIComponent(segments[1]) : ''
    if (segments.length === 2 && id) {
      if (method === 'GET') return json({ data: serializeOrder(await store.orders.require(id), store.config.orders.numberPrefix) })
      if (method === 'PATCH') {
        const patch = validateOrderPatch(await readJson(request))
        // Recording a payment is its own scope: a key that may read and stamp orders cannot
        // turn an unpaid order into a paid one unless the owner approved that too.
        if (patch.payment && caller.kind === 'connection' && !caller.connection.scopes.includes('payments')) {
          return error(403, 'forbidden', 'This connection was not approved for "payments"; reconnect and approve it at /admin/connect')
        }
        let order = await store.orders.require(id)
        if (patch.external_reference !== undefined) order = await store.orders.setExternalReference(id, patch.external_reference)
        if (patch.payment) order = await store.orders.setPaymentStatus(id, patch.payment)
        if (patch.status === 'cancelled') order = await store.orders.cancel(id, 'Cancelled by the operations system')
        return json({ data: serializeOrder(order, store.config.orders.numberPrefix) })
      }
    }
    if (segments.length === 3 && id && segments[2] === 'fulfillments' && method === 'POST') {
      const input = validateFulfillment(await readJson(request))
      const result = await store.orders.addFulfillment(id, input)
      return json({ data: serializeFulfillment(result.fulfillment) }, result.created ? 201 : 200)
    }
  }

  if (segments[0] === 'quotes') {
    const prefix = store.config.quotes.numberPrefix
    if (segments.length === 1 && method === 'GET') {
      const query = validateListQuery(url.searchParams, { defaultLimit: 50, maxLimit: 200, allowUpdatedSince: true })
      // Lazy housekeeping: offers past their expiry become `expired` before the consumer sees the list.
      await store.quotes.expireStale()
      const page = await store.quotes.changedSince(query.updatedSince, query.cursor, query.limit)
      return json({ data: page.quotes.map((q) => serializeQuote(q, prefix)), next_cursor: page.nextCursor })
    }
    const id = segments[1] ? decodeURIComponent(segments[1]) : ''
    if (segments.length === 2 && id) {
      if (method === 'GET') return json({ data: serializeQuote(await store.quotes.require(id), prefix) })
      if (method === 'PATCH') {
        const patch = validateQuotePatch(await readJson(request))
        let quote = await store.quotes.require(id)
        if (patch.external_reference !== undefined) quote = await store.quotes.setExternalReference(id, patch.external_reference)
        if (patch.offer) quote = await store.quotes.offer(id, patch.offer)
        if (patch.status === 'cancelled') quote = await store.quotes.cancel(id, 'Cancelled by the operations system')
        return json({ data: serializeQuote(quote, prefix) })
      }
    }
  }

  if (path === '/inventory' && method === 'PUT') {
    const items = validateInventory(await readJson(request))
    return json({ data: await store.inventory.set(items) })
  }

  if (path === '/products' && method === 'PUT') {
    const products = validateProducts(await readJson(request))
    return json({ data: { upserted: await store.catalog.upsertProducts(products) } })
  }

  if (path === '/products' && method === 'GET') {
    const query = validateListQuery(url.searchParams, { defaultLimit: 50, maxLimit: 200, allowUpdatedSince: true, allowActive: true })
    const page = await store.catalog.listProducts(query)
    return json({ data: page.products.map((p) => serializeProduct(p, images)), next_cursor: page.nextCursor })
  }

  if (segments[0] === 'products' && segments.length === 2) {
    const sku = decodeURIComponent(segments[1]!)
    if (method === 'GET') return json({ data: serializeProduct(await store.catalog.requireProduct(sku), images) })
    if (method === 'DELETE') {
      const done = await store.catalog.deactivateProduct(sku)
      if (!done) return error(404, 'not_found', `Product ${sku} not found`)
      return new Response(null, { status: 204 })
    }
  }

  if (path === '/categories' && method === 'PUT') {
    const categories = validateCategories(await readJson(request))
    return json({ data: { upserted: await store.catalog.upsertCategories(categories) } })
  }

  if (path === '/categories' && method === 'GET') {
    const query = validateListQuery(url.searchParams, { defaultLimit: 500, maxLimit: 1000 })
    const page = await store.catalog.listCategories(query)
    return json({ data: page.categories.map(serializeCategory), next_cursor: page.nextCursor })
  }

  return error(404, 'not_found', `No such endpoint: ${method} ${path}`)
}

export {
  serializeOrder, serializeFulfillment, serializeProduct, serializeCategory, serializeQuote, absoluteImageUrl,
  type ImageUrlResolver, type SerializeProductOptions,
  type ApiOrder, type ApiFulfillment, type ApiProduct, type ApiCategory, type ApiQuote,
} from './serialize'
export { ValidationError } from './validate'
