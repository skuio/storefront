import { describe, expect, it } from 'vitest'
import { handleStoreApi } from '../src/api'
import type { Store } from '../src/store'
import { placeOrder, products, rig, seed } from './helpers'

const KEY = 'k'.repeat(64)

/** `configured: null` runs the handler with no STORE_API_KEY set at all. */
function client(store: Store, configured: string | null = KEY) {
  const apiKey = configured ?? undefined
  return async (method: string, path: string, body?: unknown, key: string | null = apiKey ?? null) => {
    const headers: Record<string, string> = {}
    if (key !== null) headers.authorization = `Bearer ${key}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const request = new Request(`https://store.test/api/skuio/v1${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
    const response = await handleStoreApi(request, { store, apiKey })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
  }
}

describe('Store API auth', () => {
  it('refuses missing, wrong or unconfigured keys with 401 and never leaks the key', async () => {
    const { store } = rig()
    const api = client(store)
    expect((await api('GET', '/health', undefined, null)).status).toBe(401)
    expect((await api('GET', '/health', undefined, 'wrong')).status).toBe(401)
    expect((await api('GET', '/health', undefined, KEY.slice(0, 63))).status).toBe(401)
    const res = await api('GET', '/health', undefined, null)
    expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String), details: null } })
    expect(JSON.stringify(res.body)).not.toContain(KEY)
    const unconfigured = client(store, null)
    expect((await unconfigured('GET', '/health')).status).toBe(401)
  })

  it('answers health with identity and counts', async () => {
    const { store } = rig()
    await seed(store)
    const res = await client(store)('GET', '/health')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name: 'Test Store', currency: 'USD', counts: { products: 3, categories: 6, orders: 0, customers: 0 } })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('404s unknown endpoints', async () => {
    const { store } = rig()
    const res = await client(store)('GET', '/nothing')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('Store API orders', () => {
  it('lists, pages and fetches orders in the documented shape', async () => {
    const { store } = rig()
    await seed(store)
    const a = await placeOrder(store)
    const b = await placeOrder(store, { items: [{ sku: 'VDCTOYSUP9302', quantity: 2 }] })
    const api = client(store)

    const list = await api('GET', '/orders?limit=1')
    expect(list.status).toBe(200)
    expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([a.id])
    expect(list.body.next_cursor).toEqual(expect.any(String))
    const next = await api('GET', `/orders?limit=1&cursor=${encodeURIComponent(list.body.next_cursor)}`)
    expect(next.body.data.map((o: { id: string }) => o.id)).toEqual([b.id])
    expect(next.body.next_cursor).toBeNull()

    const since = await api('GET', `/orders?updated_since=${encodeURIComponent(b.updatedAt)}`)
    expect(since.body.data.map((o: { id: string }) => o.id)).toEqual([b.id])

    const one = await api('GET', `/orders/${a.id}`)
    expect(one.status).toBe(200)
    expect(one.body.data).toEqual({
      id: a.id,
      number: '1001',
      status: 'pending_payment',
      payment: { status: 'unpaid', provider: null, reference: null, method_label: null, paid_at: null },
      currency: 'USD',
      subtotal: { amount: 109900, currency: 'USD' },
      shipping: { amount: 0, currency: 'USD' },
      tax: { amount: 0, currency: 'USD' },
      discount: { amount: 0, currency: 'USD' },
      discount_code: null,
      total: { amount: 109900, currency: 'USD' },
      customer: { id: a.customer.id, email: 'ada@example.com', name: 'Ada Lovelace', phone: '+1 555 0100' },
      shipping_address: { name: 'Ada Lovelace', line1: '1 Analytical Way', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      billing_address: null,
      shipping_method: { code: 'us', name: 'Free shipping (United States)' },
      lines: [{ id: a.lines[0]!.id, sku: 'VDCTOYTAC9504', name: products[0]!.name, quantity: 1, unit_amount: { amount: 109900, currency: 'USD' }, total_amount: { amount: 109900, currency: 'USD' }, fulfilled_quantity: 0 }],
      fulfillments: [],
      external_reference: null,
      notes: null,
      metadata: {},
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      paid_at: null,
      cancelled_at: null,
    })
    expect(JSON.stringify(one.body)).not.toContain(a.accessKey)
    expect((await api('GET', '/orders/ord_nope')).status).toBe(404)
    expect((await api('GET', '/orders?limit=0')).status).toBe(422)
    expect((await api('GET', '/orders?updated_since=yesterday')).status).toBe(422)
  })

  it('patches external_reference, payment and cancellation with 409 on conflicts', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const api = client(store)

    const stamped = await api('PATCH', `/orders/${order.id}`, { external_reference: 'SO-0016' })
    expect(stamped.status).toBe(200)
    expect(stamped.body.data.external_reference).toBe('SO-0016')

    const paid = await api('PATCH', `/orders/${order.id}`, { payment: { status: 'paid', provider: 'manual', reference: 'wire-1', paid_at: '2026-09-13T10:00:00Z' } })
    expect(paid.status).toBe(200)
    expect(paid.body.data.status).toBe('paid')
    expect(paid.body.data.payment).toEqual({ status: 'paid', provider: 'manual', reference: 'wire-1', method_label: null, paid_at: '2026-09-13T10:00:00.000Z' })

    expect((await api('PATCH', `/orders/${order.id}`, { status: 'refunded' })).status).toBe(422)
    expect((await api('PATCH', `/orders/${order.id}`, {})).status).toBe(422)
    expect((await api('PATCH', `/orders/${order.id}`, 'not json')).body.error.details).toEqual({ body: 'is not valid JSON' })

    await api('POST', `/orders/${order.id}/fulfillments`, { external_id: 'sof_1', lines: [{ sku: 'VDCTOYTAC9504', quantity: 1 }] })
    const conflict = await api('PATCH', `/orders/${order.id}`, { status: 'cancelled' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('conflict')

    const other = await placeOrder(store)
    const cancelled = await api('PATCH', `/orders/${other.id}`, { status: 'cancelled' })
    expect(cancelled.body.data.status).toBe('cancelled')
    expect(cancelled.body.data.cancelled_at).toEqual(expect.any(String))
  })

  it('records fulfilments: 201 then 200 on redelivery, 422 on bad lines', async () => {
    const { store, mail } = rig()
    await seed(store)
    const order = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }] })
    const api = client(store)
    const body = { external_id: 'sof_812', carrier: 'UPS', service: 'Ground', tracking_number: '1Z9', tracking_url: 'https://ups.test/1Z9', shipped_at: '2026-09-13T15:00:00Z', lines: [{ sku: 'VDCTOYTAC9504', quantity: 1 }], notify_customer: true }
    const first = await api('POST', `/orders/${order.id}/fulfillments`, body)
    expect(first.status).toBe(201)
    expect(first.body.data).toEqual({
      id: expect.stringMatching(/^ful_/),
      external_id: 'sof_812',
      carrier: 'UPS',
      service: 'Ground',
      tracking_number: '1Z9',
      tracking_url: 'https://ups.test/1Z9',
      shipped_at: '2026-09-13T15:00:00.000Z',
      lines: [{ sku: 'VDCTOYTAC9504', quantity: 1 }],
      created_at: expect.any(String),
    })
    expect(mail.sent.map((m) => m.subject)).toEqual(['Order 1001 has shipped — Test Store'])
    const again = await api('POST', `/orders/${order.id}/fulfillments`, body)
    expect(again.status).toBe(200)
    expect(again.body.data.id).toBe(first.body.data.id)
    expect(mail.sent).toHaveLength(1)
    expect((await api('GET', `/orders/${order.id}`)).body.data.status).toBe('partially_fulfilled')

    const bad = await api('POST', `/orders/${order.id}/fulfillments`, { external_id: 'sof_813', lines: [{ sku: 'VDCTOYTAC9504', quantity: 5 }] })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toEqual({ code: 'validation_failed', message: expect.any(String), details: { 'lines.0.quantity': expect.stringContaining('exceeds the 1') } })
    const malformed = await api('POST', `/orders/${order.id}/fulfillments`, { lines: [] })
    expect(malformed.body.error.details).toEqual({ external_id: 'is required', lines: 'must be a non-empty array' })
    expect((await api('POST', `/orders/ord_nope/fulfillments`, body)).status).toBe(404)
  })
})

describe('Store API housekeeping', () => {
  it('expires abandoned processor checkouts before listing orders', async () => {
    const { store, clock } = rig()
    await seed(store)
    const abandoned = await placeOrder(store)
    await store.orders.startPayment(abandoned.id, { provider: 'stripe', kind: 'redirect' })
    const manual = await placeOrder(store)
    await store.orders.startPayment(manual.id, { provider: 'manual', kind: 'instructions' })
    clock.tick(25 * 3_600_000)
    const list = await client(store)('GET', '/orders')
    const byId = Object.fromEntries(list.body.data.map((o: { id: string; status: string; payment: { provider: string | null }; cancelled_at: string | null }) => [o.id, o]))
    expect(byId[abandoned.id]).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(String), payment: { status: 'unpaid', provider: 'stripe' } })
    expect(byId[manual.id]).toMatchObject({ status: 'pending_payment', payment: { provider: 'manual' } })
  })
})

describe('Store API catalog', () => {
  it('upserts inventory and reports unknown SKUs', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)
    const res = await api('PUT', '/inventory', { items: [{ sku: 'VDCTOYTAC9504', available: 4 }, { sku: 'GHOST', available: 1, allow_backorder: true }] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { updated: 1, unknown_skus: ['GHOST'] } })
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.availability).toMatchObject({ status: 'in_stock', quantity: 4 })
    const bad = await api('PUT', '/inventory', { items: [{ sku: 'X', available: 1.5 }] })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toEqual({ 'items.0.available': 'must be an integer' })
    const negative = await api('PUT', '/inventory', { items: [{ sku: 'VDCTOYTAC9504', available: -3 }] })
    expect(negative.status).toBe(422)
    expect(negative.body.error.details).toEqual({ 'items.0.available': 'must be a non-negative integer' })
  })

  it('upserts products and categories, validates per field, deactivates by sku', async () => {
    const { store } = rig()
    const api = client(store)
    const cats = await api('PUT', '/categories', { categories: [{ id: '10', name: 'Toyota', parent_id: null, position: 1 }, { id: '11', name: 'Tacoma', parent_id: '10', image: { url: 'https://cdn.test/t.jpg' }, position: 1 }] })
    expect(cats.status).toBe(200)
    expect(cats.body).toEqual({ data: { upserted: 2 } })

    const prods = await api('PUT', '/products', {
      products: [
        {
          sku: 'VDCANSX9005',
          name: 'Acura NSX 1990-2005 Vertical Lambo Doors',
          description_html: '<p>Kit</p>',
          price: { amount: 129900, currency: 'USD' },
          compare_at_price: null,
          images: [{ url: 'https://cdn.test/nsx.jpg', alt: 'NSX' }],
          category_ids: ['11'],
          attributes: { Fits: 'NSX' },
          active: true,
          position: 3,
        },
      ],
    })
    expect(prods.status).toBe(200)
    expect(prods.body).toEqual({ data: { upserted: 1 } })
    const catalog = await store.catalog.load()
    expect(catalog.product('VDCANSX9005')).toMatchObject({ slug: 'acura-nsx-1990-2005-vertical-lambo-doors', categoryIds: ['11'], images: [{ src: 'https://cdn.test/nsx.jpg', alt: 'NSX' }] })
    expect(catalog.categoryByPath(['toyota', 'tacoma'])!.productCount).toBe(1)
    expect(catalog.category('11')!.image).toEqual({ src: 'https://cdn.test/t.jpg' })

    const bad = await api('PUT', '/products', { products: [{ sku: 'A', price: { amount: 1.5, currency: 'USD' }, slug: 'Bad Slug' }, 'nope'] })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toEqual({ 'products.0.name': 'is required', 'products.0.price': expect.any(String), 'products.0.slug': expect.any(String), 'products.1': 'must be an object' })
    expect((await api('PUT', '/products', { products: Array.from({ length: 201 }, (_, i) => ({ sku: `S${i}`, name: 'x', price: { amount: 1, currency: 'USD' } })) })).status).toBe(422)

    expect((await api('DELETE', '/products/VDCANSX9005')).status).toBe(204)
    expect((await api('DELETE', '/products/VDCANSX9005')).status).toBe(204) // still exists, still inactive
    expect((await api('DELETE', '/products/NOPE')).status).toBe(404)
    expect((await store.catalog.load()).product('VDCANSX9005')).toBeUndefined()

    const badCat = await api('PUT', '/categories', { categories: [{ id: '1', name: 'Loop', parent_id: '1' }] })
    expect(badCat.body.error.details).toEqual({ 'categories.0.parent_id': 'cannot be the category itself' })
  })
})

describe('Store API catalog reads', () => {
  it('lists products in the documented shape, with categories, images and stock', async () => {
    const { store } = rig()
    await seed(store)
    const res = await client(store)('GET', '/products')

    expect(res.status).toBe(200)
    expect(res.body.next_cursor).toBeNull()
    expect(res.body.data).toHaveLength(3)

    const tacoma = res.body.data.find((p: { sku: string }) => p.sku === 'VDCTOYTAC9504')
    expect(tacoma).toMatchObject({
      sku: 'VDCTOYTAC9504',
      name: 'Toyota Tacoma 1995-2004 Vertical Lambo Doors',
      slug: 'toyota-tacoma-1995-2004-vertical-lambo-doors',
      price: { amount: 109900, currency: 'USD' },
      compare_at: { amount: 129500, currency: 'USD' },
      attributes: { Fits: '1995-2004' },
      active: true,
      categories: [{ id: 'tacoma', slug: 'tacoma', name: 'Tacoma' }],
      images: [{ url: 'https://cdn.test/tacoma.jpg', alt: 'Tacoma', position: 0 }],
      // Seeded stock only exists for the Civic, so this one reports none rather than zero.
      inventory: null,
    })
    expect(typeof tacoma.created_at).toBe('string')
    expect(typeof tacoma.updated_at).toBe('string')
    expect(Number.isInteger(tacoma.price.amount)).toBe(true)

    // A product with no compare-at and no images still answers with the full shape.
    const supra = res.body.data.find((p: { sku: string }) => p.sku === 'VDCTOYSUP9302')
    expect(supra).toMatchObject({ compare_at: null, images: [], attributes: {} })
    expect(Array.isArray(supra.attributes)).toBe(false)

    const civic = res.body.data.find((p: { sku: string }) => p.sku === 'VDCHCIV0611')
    expect(civic.inventory).toEqual({ available: 0, allow_backorder: false, updated_at: expect.any(String) })
  })

  it('pages by cursor without repeating or skipping a row', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: { status: number; body: { data: { sku: string }[]; next_cursor: string | null } } = await api(
        'GET',
        `/products?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      )
      expect(res.status).toBe(200)
      seen.push(...res.body.data.map((p) => p.sku))
      cursor = res.body.next_cursor
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(2)
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toEqual(expect.arrayContaining(['VDCTOYTAC9504', 'VDCTOYSUP9302', 'VDCHCIV0611']))

    const firstPage = await api('GET', '/products?limit=2')
    const second = await api('GET', `/products?limit=2&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`)
    const firstSkus = firstPage.body.data.map((p: { sku: string }) => p.sku)
    expect(second.body.data.every((p: { sku: string }) => !firstSkus.includes(p.sku))).toBe(true)
    expect(second.body.next_cursor).toBeNull()

    expect((await api('GET', '/products?cursor=not-a-cursor')).status).toBe(422)
  })

  it('filters by updated_since and by active', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)

    const all = await api('GET', '/products')
    const watermark = all.body.data[all.body.data.length - 1].updated_at

    // Nothing has changed since the newest row's own timestamp + 1ms.
    const after = new Date(Date.parse(watermark) + 1).toISOString()
    const none = await api('GET', `/products?updated_since=${encodeURIComponent(after)}`)
    expect(none.body.data).toEqual([])
    expect(none.body.next_cursor).toBeNull()

    await store.catalog.upsertProducts([{ sku: 'VDCTOYSUP9302', name: 'Toyota Supra (renamed)', price: { amount: 119900, currency: 'USD' } }])
    const changed = await api('GET', `/products?updated_since=${encodeURIComponent(after)}`)
    expect(changed.body.data.map((p: { sku: string }) => p.sku)).toEqual(['VDCTOYSUP9302'])
    expect(changed.body.data[0].name).toBe('Toyota Supra (renamed)')

    expect((await api('DELETE', '/products/VDCHCIV0611')).status).toBe(204)
    expect((await api('GET', '/products?active=true')).body.data.map((p: { sku: string }) => p.sku)).not.toContain('VDCHCIV0611')
    expect((await api('GET', '/products?active=false')).body.data.map((p: { sku: string }) => p.sku)).toEqual(['VDCHCIV0611'])
    expect((await api('GET', '/products')).body.data).toHaveLength(3)

    const bad = await api('GET', '/products?active=maybe&updated_since=not-a-date&limit=0')
    expect(bad.status).toBe(422)
    expect(bad.body.error).toMatchObject({
      code: 'validation_failed',
      details: { active: 'must be true or false', updated_since: 'must be an ISO-8601 timestamp', limit: 'must be an integer from 1 to 200' },
    })
    expect((await api('GET', '/products?limit=201')).status).toBe(422)
    expect((await api('GET', '/products?limit=abc')).status).toBe(422)
    expect((await api('GET', '/products?limit=200')).status).toBe(200)
  })

  it('fetches one product by sku and 404s an unknown one', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)

    const res = await api('GET', '/products/VDCTOYTAC9504')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sku: 'VDCTOYTAC9504', categories: [{ id: 'tacoma' }] })

    const missing = await api('GET', '/products/NOPE-SKU')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: { code: 'not_found', message: expect.any(String), details: null } })

    // An inactive product is still readable — SKU.io must see what the store holds.
    expect((await api('DELETE', '/products/VDCTOYTAC9504')).status).toBe(204)
    const inactive = await api('GET', '/products/VDCTOYTAC9504')
    expect(inactive.status).toBe(200)
    expect(inactive.body.data.active).toBe(false)
  })

  it('lists the category tree with product counts, parents before children', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)

    const res = await api('GET', '/categories')
    expect(res.status).toBe(200)
    expect(res.body.next_cursor).toBeNull()
    expect(res.body.data).toHaveLength(6)

    const byId = new Map(res.body.data.map((c: { id: string }) => [c.id, c]))
    expect(byId.get('toyota')).toMatchObject({ id: 'toyota', parent_id: null, slug: 'toyota', name: 'Toyota', product_count: 0 })
    expect(byId.get('tacoma')).toMatchObject({ parent_id: 'toyota', product_count: 1 })
    expect(byId.get('empty')).toMatchObject({ product_count: 0 })

    const order = res.body.data.map((c: { id: string }) => c.id)
    expect(order.indexOf('toyota')).toBeLessThan(order.indexOf('tacoma'))
    expect(order.indexOf('honda')).toBeLessThan(order.indexOf('civic'))

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: { body: { data: { id: string }[]; next_cursor: string | null } } = await api('GET', `/categories?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...page.body.data.map((c) => c.id))
      cursor = page.body.next_cursor
      pages++
    } while (cursor && pages < 10)
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
    expect(seen).toEqual(order)

    expect((await api('GET', '/categories?limit=1001')).status).toBe(422)
    expect((await api('GET', '/categories?cursor=zzz')).status).toBe(422)
  })

  it('reports a link to a category the store never received instead of dropping it', async () => {
    const { store, db } = rig()
    await seed(store)
    db.raw.exec(`INSERT INTO product_categories (sku, category_id, position) VALUES ('VDCTOYSUP9302', '98', 5)`)

    const res = await client(store)('GET', '/products/VDCTOYSUP9302')
    expect(res.status).toBe(200)
    expect(res.body.data.categories).toEqual([
      { id: 'supra', slug: 'supra', name: 'Supra' },
      { id: '98', slug: null, name: null },
    ])
  })

  it('refuses catalog reads without a key', async () => {
    const { store } = rig()
    await seed(store)
    const api = client(store)
    expect((await api('GET', '/products', undefined, null)).status).toBe(401)
    expect((await api('GET', '/products/VDCTOYTAC9504', undefined, null)).status).toBe(401)
    expect((await api('GET', '/categories', undefined, null)).status).toBe(401)
  })
})
