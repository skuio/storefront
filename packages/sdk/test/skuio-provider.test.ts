import { describe, expect, it, vi } from 'vitest'
import { skuioProvider, SkuioApiError } from '../src/providers/skuio.js'
import { Catalog } from '../src/catalog.js'

/**
 * Fixtures mirror the examples in docs/api/storefront-v1.openapi.yaml. If the
 * contract changes, change both — this test is how the provider stays honest.
 */
const storefront = {
  id: 'sf_01J8', name: 'Vertical Lambo Doors', currency: 'usd', locale: 'en-US',
  domains: ['www.example-doors.com'],
  checkout: { processor: 'stripe', max_quantity: 10, allow_promotion_codes: true, collect_phone: true, ship_to_countries: ['US', 'CA'] },
}
const categoryPage = {
  data: [
    { id: '81', name: 'Toyota', slug: 'toyota', parent_id: null, description_html: null, image: null, position: 1 },
    { id: '94', name: 'Tacoma 95-04', slug: 'tacoma-95-04', parent_id: '81', description_html: null, image: { url: 'https://cdn/x.jpg', alt: null }, position: 1 },
    { id: '95', name: 'Supra 93-02', slug: 'supra-93-02', parent_id: '81', description_html: '<p>Supra</p>', image: null, position: 2 },
  ],
  next_cursor: null,
}
const productPage1 = {
  data: [{
    id: '2559', sku: 'VDCTOYTAC9504', name: 'TOYOTA TACOMA TRUCK 1995-2004 VERTICAL LAMBO DOORS',
    slug: 'toyota-tacoma-truck-1995-2004-vertical-lambo-doors',
    description_html: '<p>Part number VDCTOYTAC9504 …</p>', short_description_html: '<p>Bolt-on …</p>',
    price: { amount: 109900, currency: 'usd' }, compare_at_price: { amount: 129500, currency: 'usd' },
    category_ids: ['94', '81'],
    images: [{ url: 'https://cdn.example.com/VDCTOYTAC9504.jpg', alt: 'Toyota Tacoma with vertical doors' }],
    availability: { status: 'in_stock', expected_at: null, updated_at: '2026-09-10T18:00:00Z' },
    attributes: { Fits: '1995-2004 Toyota Tacoma, all trims' }, updated_at: '2026-09-10T18:00:00Z',
  }],
  next_cursor: 'c2Vjb25k',
}
const productPage2 = {
  data: [{
    id: '2560', sku: 'VDCTOYSUP9302', name: 'TOYOTA SUPRA 1993-2002 VERTICAL LAMBO DOORS',
    slug: 'toyota-supra-1993-2002-vertical-lambo-doors', description_html: null, short_description_html: null,
    price: { amount: 119900, currency: 'usd' }, compare_at_price: null, category_ids: ['95', '81'], images: [],
    availability: { status: 'out_of_stock', expected_at: null, updated_at: '2026-09-10T18:00:00Z' },
    attributes: {}, updated_at: '2026-09-10T18:00:00Z',
  }],
  next_cursor: null,
}
const checkoutCreated = {
  id: 'chk_01J8X', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_live_a1b2', processor: 'stripe',
  processor_session_id: 'cs_live_a1b2', currency: 'usd',
  subtotal: { amount: 109900, currency: 'usd' }, shipping: { amount: 0, currency: 'usd' }, total: { amount: 109900, currency: 'usd' },
  lines: [{ sku: 'VDCTOYTAC9504', name: 'TOYOTA TACOMA TRUCK 1995-2004 VERTICAL LAMBO DOORS', quantity: 1, unit_price: { amount: 109900, currency: 'usd' }, total: { amount: 109900, currency: 'usd' } }],
  customer: null, shipping_address: null, sales_order_id: null, metadata: {}, created_at: '2026-09-11T02:10:00Z', expires_at: '2026-09-12T02:10:00Z',
}
const checkoutCompleted = {
  ...checkoutCreated, status: 'completed', url: null,
  customer: { name: 'QA Buyer', email: 'qa@example.com', phone: '+17025550147' },
  shipping_address: { name: 'QA Buyer', line1: '6185 Beesley Dr', line2: null, city: 'Las Vegas', state: 'NV', postal_code: '89115', country: 'US' },
  sales_order_id: 'so_3992', expires_at: null,
}

const customer = {
  id: 'cus_01J8', email: 'qa@example.com', name: 'QA Buyer', phone: '+17025550147', customer_group: null,
  default_shipping_address: { name: 'QA Buyer', line1: '6185 Beesley Dr', line2: null, city: 'Las Vegas', state: 'NV', postal_code: '89115', country: 'US' },
}
const session = { session_token: 'cst_9f8e7d6c5b4a', expires_at: '2026-10-11T02:00:00Z', customer }
const customerOrders = {
  data: [{
    id: 'so_3992', reference: '3992', status: 'completed', fulfillment_status: 'fulfilled', currency: 'usd',
    subtotal: { amount: 159900, currency: 'usd' }, shipping: { amount: 0, currency: 'usd' }, total: { amount: 159900, currency: 'usd' },
    lines: [{ sku: 'VDCCHEVYCORC60508', name: 'CHEVROLET CORVETTE C6 2005-2013 VERTICAL LAMBO DOORS', quantity: 1, unit_price: { amount: 159900, currency: 'usd' }, total: { amount: 159900, currency: 'usd' }, image: 'https://cdn.example.com/VDCCHEVYCORC60508.jpg' }],
    shipments: [{ carrier: 'FedEx', tracking_number: '123456789012', tracking_url: 'https://www.fedex.com/fedextrack/?trknbr=123456789012', shipped_at: '2026-09-02T17:00:00Z' }],
    shipping_address: { name: 'QA Buyer', line1: '6185 Beesley Dr', line2: null, city: 'Las Vegas', state: 'NV', postal_code: '89115', country: 'US' },
    channel: 'Example Doors', created_at: '2026-08-29T15:12:00Z',
  }],
  next_cursor: null,
}

/** A tiny router standing in for the tenant. Records every request it sees. */
function fakeTenant(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  const seen: { url: string; init?: RequestInit }[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const routes: Record<string, (init?: RequestInit) => Response> = {
    '/storefront': () => json(storefront),
    '/categories?limit=100': () => json(categoryPage),
    '/products?limit=100': () => json(productPage1),
    '/products?limit=100&cursor=c2Vjb25k': () => json(productPage2),
    '/checkouts': (init) => (init?.method === 'POST' ? json(checkoutCreated, 201) : json({ error: { code: 'method', message: 'nope' } }, 405)),
    '/checkouts/chk_01J8X': () => json(checkoutCompleted),
    '/customers/session': (init) => (init?.method === 'POST' ? new Response(null, { status: 202 }) : init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ error: { code: 'method', message: 'nope' } }, 405)),
    '/customers/session/exchange': (init) => (JSON.parse(String(init?.body)).token === 'good' ? json(session) : json({ error: { code: 'invalid_token', message: 'Link expired' } }, 401)),
    '/customers/me': () => json(customer),
    '/customers/me/orders?limit=100': () => json(customerOrders),
    ...overrides,
  }
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init })
    const path = url.replace('https://acme.sku.io/api/storefront/v1', '')
    const handler = routes[path]
    return handler ? handler(init) : json({ error: { code: 'not_found', message: `no route ${path}` } }, 404)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, seen }
}

const make = (t = fakeTenant()) => ({
  t,
  provider: skuioProvider({ tenant: 'https://acme.sku.io', storefrontToken: 'sf_test_abc', fetch: t.fetch }),
})

describe('skuioProvider', () => {
  it('refuses anything but a storefront token, before any request', () => {
    expect(() => skuioProvider({ tenant: 'https://acme.sku.io', storefrontToken: 'pat_admin_xyz' })).toThrow(/storefront token/)
  })

  it('sends the bearer token and follows cursor pagination to the end', async () => {
    const { t, provider } = make()
    const products = await provider.products()
    expect(products.map((p) => p.sku)).toEqual(['VDCTOYTAC9504', 'VDCTOYSUP9302'])
    expect(t.seen.map((s) => s.url.split('/v1')[1])).toEqual(['/products?limit=100', '/products?limit=100&cursor=c2Vjb25k'])
    const headers = t.seen[0]!.init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sf_test_abc')
  })

  it('maps the wire shape onto the SDK Product, deriving available from availability', async () => {
    const { provider } = make()
    const [tacoma, supra] = await provider.products()
    expect(tacoma).toMatchObject({
      id: '2559', sku: 'VDCTOYTAC9504', price: { amount: 109900, currency: 'usd' },
      compareAtPrice: { amount: 129500, currency: 'usd' }, categoryIds: ['94', '81'],
      images: [{ src: 'https://cdn.example.com/VDCTOYTAC9504.jpg', alt: 'Toyota Tacoma with vertical doors' }],
      available: true, availability: { status: 'in_stock', updatedAt: '2026-09-10T18:00:00Z' },
      attributes: { Fits: '1995-2004 Toyota Tacoma, all trims' },
      description: '<p>Part number VDCTOYTAC9504 …</p>',
    })
    expect(supra!.available).toBe(false)
    expect(supra!.compareAtPrice).toBeUndefined()
    expect(supra!.attributes).toBeUndefined()
  })

  it('maps categories and the result loads into a Catalog with the right tree', async () => {
    const { provider } = make()
    const catalog = await Catalog.load(provider)
    expect(catalog.category('94')?.parentId).toBe('81')
    expect(catalog.category('94')?.image).toBe('https://cdn/x.jpg')
    expect(catalog.category('95')?.description).toBe('<p>Supra</p>')
    expect(catalog.categoryByPath(['toyota', 'tacoma-95-04'])?.productCount).toBe(1)
    expect(catalog.breadcrumbs(catalog.product('VDCTOYTAC9504')!).map((c) => c.slug)).toEqual(['toyota', 'tacoma-95-04'])
  })

  it('creates a checkout with the wire request shape and maps the response', async () => {
    const { t, provider } = make()
    const checkout = await provider.createCheckout!({
      items: [{ sku: 'VDCTOYTAC9504', quantity: 1 }],
      successUrl: 'https://x/ok?checkout_id={CHECKOUT_ID}',
      cancelUrl: 'https://x/no',
      metadata: { product_url: 'https://x/p' },
    })
    const req = t.seen.find((s) => s.url.endsWith('/checkouts'))!
    expect(req.init!.method).toBe('POST')
    expect(JSON.parse(req.init!.body as string)).toEqual({
      items: [{ sku: 'VDCTOYTAC9504', quantity: 1 }],
      success_url: 'https://x/ok?checkout_id={CHECKOUT_ID}',
      cancel_url: 'https://x/no',
      metadata: { product_url: 'https://x/p' },
    })
    expect(checkout).toMatchObject({ id: 'chk_01J8X', status: 'open', url: expect.stringContaining('checkout.stripe.com'), total: { amount: 109900 } })
    expect(checkout.lines[0]).toMatchObject({ sku: 'VDCTOYTAC9504', unitPrice: { amount: 109900 } })
    expect(checkout.customer).toBeUndefined()
  })

  it('reads a completed checkout with customer, address and the sales order id', async () => {
    const { provider } = make()
    const c = await provider.getCheckout!('chk_01J8X')
    expect(c.status).toBe('completed')
    expect(c.url).toBeNull()
    expect(c.salesOrderId).toBe('so_3992')
    expect(c.customer).toEqual({ name: 'QA Buyer', email: 'qa@example.com', phone: '+17025550147' })
    expect(c.shippingAddress).toMatchObject({ line1: '6185 Beesley Dr', state: 'NV', postalCode: '89115', line2: undefined })
    expect(c.expiresAt).toBeUndefined()
  })

  it('surfaces API errors with their code and status', async () => {
    const json = (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
    const { provider } = make(fakeTenant({
      '/products?limit=100': () => json({ error: { code: 'invalid_token', message: 'Storefront token is not valid' } }, 401),
      '/checkouts': () => json({ error: { code: 'unpurchasable_sku', message: 'VDCTOYSUP9302 is out of stock', details: { sku: 'VDCTOYSUP9302' } } }, 422),
    }))
    await expect(provider.products()).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
    const err = await provider.createCheckout!({ items: [{ sku: 'VDCTOYSUP9302', quantity: 1 }], successUrl: 'https://x', cancelUrl: 'https://x' }).catch((e) => e)
    expect(err).toBeInstanceOf(SkuioApiError)
    expect(err).toMatchObject({ status: 422, code: 'unpurchasable_sku', details: { sku: 'VDCTOYSUP9302' } })
  })
})

describe('skuioProvider.customers', () => {
  it('requests a magic link and resolves on 202 with no body', async () => {
    const { t, provider } = make()
    await expect(provider.customers!.requestSession('qa@example.com', 'https://x/account/verify')).resolves.toBeUndefined()
    const req = t.seen.find((s) => s.url.endsWith('/customers/session'))!
    expect(JSON.parse(req.init!.body as string)).toEqual({ email: 'qa@example.com', return_url: 'https://x/account/verify' })
  })

  it('exchanges a token for a session and maps the customer', async () => {
    const { provider } = make()
    const s = await provider.customers!.exchange('good')
    expect(s.sessionToken).toBe('cst_9f8e7d6c5b4a')
    expect(s.customer).toMatchObject({ id: 'cus_01J8', email: 'qa@example.com', name: 'QA Buyer' })
    expect(s.customer.defaultShippingAddress).toMatchObject({ line1: '6185 Beesley Dr', postalCode: '89115', line2: undefined })
    expect(s.customer.customerGroup).toBeUndefined()
    await expect(provider.customers!.exchange('stale')).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })

  it('sends the session header alongside the bearer for customer calls', async () => {
    const { t, provider } = make()
    const orders = await provider.customers!.orders('cst_9f8e7d6c5b4a')
    const req = t.seen.find((s) => s.url.includes('/customers/me/orders'))!
    const h = req.init!.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer sf_test_abc')
    expect(h['X-Customer-Session']).toBe('cst_9f8e7d6c5b4a')
    expect(orders[0]).toMatchObject({
      id: 'so_3992', reference: '3992', status: 'completed', fulfillmentStatus: 'fulfilled',
      total: { amount: 159900 }, channel: 'Example Doors',
    })
    expect(orders[0]!.lines[0]).toMatchObject({ sku: 'VDCCHEVYCORC60508', image: expect.stringContaining('.jpg') })
    expect(orders[0]!.shipments[0]).toMatchObject({ carrier: 'FedEx', trackingNumber: '123456789012' })
    await expect(provider.customers!.revoke('cst_9f8e7d6c5b4a')).resolves.toBeUndefined()
  })
})
