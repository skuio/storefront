import { isAfter, isoSeconds, isWithin, ProcessorPermissionError, type PaymentAdapter, type PaymentPayouts, type Payout, type PayoutLine, type PayoutPosition } from '../payments'
import type { Connection, Store } from '../store'
import type { Order } from '../types'
import { API_KEY_PREFIX, type ConnectScope } from '../store/connections'
import { secretsEqual } from '../store/crypto'
import { decodeKeysetCursor, encodeKeysetCursor } from '../store/cursor'
import { StoreError } from '../store/errors'
import {
  serializeCategory, serializeFulfillment, serializeOrder, serializePayout, serializePayoutLine, serializeProduct, serializeQuote,
  type ImageUrlResolver, type SerializeProductOptions,
} from './serialize'
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
  /**
   * The store's payment adapters, or a function returning them (called only when needed, so a
   * processor client is not built on every request). `GET /orders/{id}` uses the adapter that took
   * a paid order to ask its processor for the fee when the store has not recorded it yet. Omit it
   * and the fee is only what the adapters recorded when they confirmed the payment.
   */
  payments?: PaymentAdapter[] | (() => PaymentAdapter[])
}

/** How long `GET /orders/{id}` waits for a processor before answering without the fee. */
const SETTLEMENT_TIMEOUT_MS = 8000

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
    return await route(method, path, url, request, options.store, caller, images, options.payments)
  } catch (e) {
    if (e instanceof ValidationError) return error(422, 'validation_failed', e.message, e.details)
    if (e instanceof StoreError) return error(e.status, e.code, e.message, e.details)
    if (e instanceof ProcessorPermissionError) {
      return error(424, 'processor_permission_missing', e.message, { provider: e.provider, permission: e.permission })
    }
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
  // Payouts itemise the money behind orders (fees, refunds, disputes): readable with the orders scope.
  if (first === 'payouts') return 'orders'
  return null // /health, /connect
}

async function route(
  method: string, path: string, url: URL, request: Request, store: Store, caller: ApiCaller, images: SerializeProductOptions,
  payments: StoreApiOptions['payments']
): Promise<Response> {
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
      if (method === 'GET') {
        const order = await fillSettlement(store, await store.orders.require(id), payments)
        return json({ data: serializeOrder(order, store.config.orders.numberPrefix) })
      }
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

  if (segments[0] === 'payouts' && method === 'GET') return payoutsRoute(segments, url, store, payments)

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

/**
 * Lazy fill for one order: a paid (or since refunded) order whose fee is not recorded yet asks the
 * processor that took it, through that adapter's `settlement()`, and stores the answer (which bumps
 * `updated_at`). Any failure — no adapter, a processor error, a timeout — returns the order unchanged:
 * reading an order never fails because the processor is unreachable.
 */
async function fillSettlement(store: Store, order: Order, payments: StoreApiOptions['payments']): Promise<Order> {
  if (!payments || order.payment.fee || !order.payment.provider || !order.payment.reference) return order
  if (order.payment.status !== 'paid' && order.payment.status !== 'refunded') return order
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const adapters = typeof payments === 'function' ? payments() : payments
    const adapter = adapters.find((a) => a.id === order.payment.provider)
    if (!adapter?.settlement) return order
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SETTLEMENT_TIMEOUT_MS)
    })
    const settlement = await Promise.race([adapter.settlement(order), timeout])
    if (!settlement) return order
    return await store.orders.recordSettlement(order.id, settlement)
  } catch (e) {
    console.error('store api: could not read the payment settlement for', order.id, e instanceof Error ? e.message : String(e))
    return order
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** When `created_since` is omitted, payouts from the last 90 days. */
const DEFAULT_PAYOUT_LOOKBACK_MS = 90 * 86_400_000

function payoutAdapters(payments: StoreApiOptions['payments']): { id: string; payouts: PaymentPayouts }[] {
  if (!payments) return []
  const adapters = typeof payments === 'function' ? payments() : payments
  const seen = new Set<string>()
  const out: { id: string; payouts: PaymentPayouts }[] = []
  for (const a of adapters) {
    if (!a.payouts || seen.has(a.id)) continue
    seen.add(a.id)
    out.push({ id: a.id, payouts: a.payouts })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** `(created_at, provider, id)` ascending: the merged list's order and its cursor's. */
function compareMergedPayouts(a: Payout, b: Payout): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function limitParam(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get('limit')
  if (!raw) return fallback
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new ValidationError('Invalid query', { limit: `must be an integer from 1 to ${max}` })
  return limit
}

/** `<provider>_mode` (e.g. `paypal_mode=balance`): passed to that provider's adapter only, which validates it. */
function modeParam(url: URL, provider: string): string | null {
  return url.searchParams.get(`${provider}_mode`)
}

/**
 * Every payout-capable provider's account, for `accounts` on the list: a provider that cannot name
 * its account cheaply (no method, null, or an error) is left out rather than failing the list.
 */
async function payoutAccounts(adapters: { id: string; payouts: PaymentPayouts }[]): Promise<{ provider: string; account_id: string }[]> {
  const found = await Promise.all(
    adapters.map(async (a) => {
      try {
        const id = a.payouts.account ? await a.payouts.account() : null
        return id ? [{ provider: a.id, account_id: id }] : []
      } catch {
        return []
      }
    })
  )
  return found.flat()
}

/**
 * `GET /payouts`, `/payouts/{provider}/{id}`, `/payouts/{provider}/{id}/lines`. The list merges every
 * payout-capable adapter (or the one `provider` names), ascending by `(created_at, provider, id)`;
 * its cursor is that position.
 */
async function payoutsRoute(segments: string[], url: URL, store: Store, payments: StoreApiOptions['payments']): Promise<Response> {
  const adapters = payoutAdapters(payments)
  const providers = adapters.map((a) => a.id)
  const adapterFor = (provider: string) => {
    const found = adapters.find((a) => a.id === provider)
    if (!found) throw new StoreError('not_found', `No payout-capable payment provider "${provider}" on this store`, { provider: providers.length ? `must be one of ${providers.join(', ')}` : 'this store has none' })
    return found
  }

  if (segments.length === 1) {
    const provider = url.searchParams.get('provider')
    const since = url.searchParams.get('created_since')
    if (since && Number.isNaN(Date.parse(since))) throw new ValidationError('Invalid query', { created_since: 'must be an ISO-8601 timestamp' })
    const requestedSince = since ? new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z') : new Date(Date.now() - DEFAULT_PAYOUT_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const limit = limitParam(url, 50, 100)
    const cursorRaw = url.searchParams.get('cursor')
    let cursor: { createdAt: string; provider: string; id: string; until: string; since: string } | null = null
    if (cursorRaw) {
      const parts = decodeKeysetCursor(cursorRaw, 5)
      if (!parts || !parts.every((p) => typeof p === 'string') || !parts[4]) throw new ValidationError('Invalid query', { cursor: 'was not issued by this store' })
      cursor = { createdAt: parts[0] as string, provider: parts[1] as string, id: parts[2] as string, until: parts[3] as string, since: parts[4] as string }
    }
    const chosen = provider ? [adapterFor(provider)] : adapters
    // Both bounds are fixed by the first page and carried in the cursor, so later pages never
    // recompute them from the clock. The lower one is created_since (or 90 days before the first page).
    // The upper one, for a merged list only: now minus the largest reporting lag among the merged
    // processors (PayPal's configured lag, Stripe none), so a processor that reports late never has
    // a payout appear behind a cursor another processor already moved past. A single-provider list
    // keeps the adapter's own horizon ('' in the cursor).
    const lag = Math.max(0, ...chosen.map((a) => a.payouts.reportingLagMs ?? 0))
    const until = cursor ? cursor.until : provider ? '' : isoSeconds(new Date(Date.now() - lag))
    const createdSince = cursor ? cursor.since : requestedSince

    const pages = await Promise.all(
      chosen.map(async (a) => {
        // Keyset on (created_at, provider, id), mapped onto each adapter's (created_at, id).
        let after: PayoutPosition | null = null
        if (cursor) {
          if (a.id === cursor.provider) after = { createdAt: cursor.createdAt, id: cursor.id }
          else if (a.id > cursor.provider) after = { createdAt: cursor.createdAt, id: '' }
          else after = { createdAt: cursor.createdAt, id: '\uffff' }
        }
        const page = await a.payouts.list({ createdSince, after, limit, until: until || null, mode: modeParam(url, a.id) })
        return { ...page, payouts: page.payouts.filter((p) => isAfter(p, after) && isWithin(p, until)) }
      })
    )
    // The same (created_at, provider, id) order the cursor filter above assumes; any other order skips or repeats.
    const merged = pages.flatMap((p) => p.payouts).sort(compareMergedPayouts)
    const page = merged.slice(0, limit)
    const more = merged.length > limit || pages.some((p) => p.hasMore)
    const last = page[page.length - 1]
    // After the pages: an adapter may have learned its account id while listing (PayPal's search).
    const accounts = await payoutAccounts(adapters)
    return json({
      data: page.map(serializePayout),
      next_cursor: more && last ? encodeKeysetCursor([last.createdAt, last.provider, last.id, until, createdSince]) : null,
      providers,
      accounts,
    })
  }

  const provider = decodeURIComponent(segments[1] ?? '')
  const id = decodeURIComponent(segments[2] ?? '')
  if (provider && id && segments.length === 3) {
    const payout = await adapterFor(provider).payouts.get(id, { mode: modeParam(url, provider) })
    if (!payout) throw new StoreError('not_found', `Payout ${id} not found`)
    return json({ data: serializePayout(payout) })
  }
  if (provider && id && segments.length === 4 && segments[3] === 'lines') {
    const adapter = adapterFor(provider)
    const page = await adapter.payouts.lines(id, { cursor: url.searchParams.get('cursor'), limit: limitParam(url, 100, 100), mode: modeParam(url, provider) })
    const lines = await withOrders(store, provider, page.lines)
    return json({ data: lines.map(serializePayoutLine), next_cursor: page.nextCursor })
  }
  return error(404, 'not_found', `No such endpoint: GET /${segments.join('/')}`)
}

/**
 * Fill a line's order from the store's own records when the processor did not carry it (a PayPal
 * refund of a capture outside the searched range) or carried only the id. One bulk read of just
 * id, number and payment reference for the whole page; a database failure fails the request (a 200
 * with order links silently missing would post an unlinked refund), a missing order stays null.
 */
async function withOrders(store: Store, provider: string, lines: PayoutLine[]): Promise<PayoutLine[]> {
  const pending = lines.filter((l) => !(l.orderId && l.orderNumber))
  const ids = pending.flatMap((l) => (l.orderId ? [l.orderId] : []))
  const references = pending.flatMap((l) => (!l.orderId && l.paymentReference ? [l.paymentReference] : []))
  if (!ids.length && !references.length) return lines
  const found = await store.orders.paymentLinks(provider, ids, references)
  const byId = new Map(found.map((o) => [o.id, o]))
  const byReference = new Map(found.flatMap((o) => (o.reference ? [[o.reference, o] as const] : [])))
  return lines.map((line) => {
    if (line.orderId && line.orderNumber) return line
    const order = line.orderId ? byId.get(line.orderId) : line.paymentReference ? byReference.get(line.paymentReference) : undefined
    if (!order) return line
    return { ...line, orderId: order.id, orderNumber: line.orderNumber ?? order.number }
  })
}

export type { Payout, PayoutLine }

export {
  serializeOrder, serializeFulfillment, serializeProduct, serializeCategory, serializeQuote, absoluteImageUrl,
  type ImageUrlResolver, type SerializeProductOptions,
  serializePayout, serializePayoutLine,
  type ApiOrder, type ApiOrderPayment, type ApiFulfillment, type ApiProduct, type ApiCategory, type ApiQuote,
  type ApiPayout, type ApiPayoutLine,
} from './serialize'
export { ValidationError } from './validate'
