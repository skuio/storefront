import type { Store } from '../store'
import { secretsEqual } from '../store/crypto'
import { StoreError } from '../store/errors'
import { serializeCategory, serializeFulfillment, serializeOrder, serializeProduct } from './serialize'
import {
  validateCategories, validateFulfillment, validateInventory, validateListQuery, validateOrderPatch, validateProducts, ValidationError,
} from './validate'

export interface StoreApiOptions {
  store: Store
  /** The STORE_API_KEY secret. When unset every request is refused. */
  apiKey: string | undefined
  /** Where the API is mounted in the request URL. */
  basePath?: string
}

export const STORE_API_BASE = '/api/skuio/v1'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

const error = (status: number, code: string, message: string, details: Record<string, string> | null = null) =>
  json({ error: { code, message, details } }, status)

/**
 * The Store API (`docs/store-api.md`) as one fetch-style handler. Mount it on
 * a catch-all route under `/api/skuio/v1` and hand it every method.
 */
export async function handleStoreApi(request: Request, options: StoreApiOptions): Promise<Response> {
  const base = (options.basePath ?? STORE_API_BASE).replace(/\/+$/, '')
  const url = new URL(request.url)
  const at = url.pathname.indexOf(base)
  if (at < 0) return error(404, 'not_found', 'No such endpoint')
  const path = url.pathname.slice(at + base.length).replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()

  if (!(await authorized(request, options.apiKey))) return error(401, 'unauthorized', 'A valid bearer STORE_API_KEY is required')

  try {
    return await route(method, path, url, request, options.store)
  } catch (e) {
    if (e instanceof ValidationError) return error(422, 'validation_failed', e.message, e.details)
    if (e instanceof StoreError) return error(e.status, e.code, e.message, e.details)
    console.error('store api: unhandled error', e)
    return error(500, 'internal_error', 'The store could not complete the request')
  }
}

async function authorized(request: Request, apiKey: string | undefined): Promise<boolean> {
  if (!apiKey) return false
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  return secretsEqual(match[1]!.trim(), apiKey)
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

async function route(method: string, path: string, url: URL, request: Request, store: Store): Promise<Response> {
  const segments = path.split('/').filter(Boolean)

  if (path === '/health' && method === 'GET') return json({ data: await store.health() })

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
      return json({ data: page.orders.map(serializeOrder), next_cursor: page.nextCursor })
    }
    const id = segments[1] ? decodeURIComponent(segments[1]) : ''
    if (segments.length === 2 && id) {
      if (method === 'GET') return json({ data: serializeOrder(await store.orders.require(id)) })
      if (method === 'PATCH') {
        const patch = validateOrderPatch(await readJson(request))
        let order = await store.orders.require(id)
        if (patch.external_reference !== undefined) order = await store.orders.setExternalReference(id, patch.external_reference)
        if (patch.payment) order = await store.orders.setPaymentStatus(id, patch.payment)
        if (patch.status === 'cancelled') order = await store.orders.cancel(id, 'Cancelled by the operations system')
        return json({ data: serializeOrder(order) })
      }
    }
    if (segments.length === 3 && id && segments[2] === 'fulfillments' && method === 'POST') {
      const input = validateFulfillment(await readJson(request))
      const result = await store.orders.addFulfillment(id, input)
      return json({ data: serializeFulfillment(result.fulfillment) }, result.created ? 201 : 200)
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
    return json({ data: page.products.map(serializeProduct), next_cursor: page.nextCursor })
  }

  if (segments[0] === 'products' && segments.length === 2) {
    const sku = decodeURIComponent(segments[1]!)
    if (method === 'GET') return json({ data: serializeProduct(await store.catalog.requireProduct(sku)) })
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
  serializeOrder, serializeFulfillment, serializeProduct, serializeCategory,
  type ApiOrder, type ApiFulfillment, type ApiProduct, type ApiCategory,
} from './serialize'
export { ValidationError } from './validate'
