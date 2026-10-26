import { describe, expect, it } from 'vitest'
import { handleStoreApi } from '../src/api'
import { defineStorefront } from '../src'
import type { Store } from '../src/store'
import { config, rig, seed, usAddress } from './helpers'

const KEY = 'k'.repeat(64)

function client(store: Store) {
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await handleStoreApi(new Request(`https://store.test/api/store/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
      store,
      apiKey: KEY,
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}

/** A guest — no account, no session — asking for a volume price. */
const guestRequest = (overrides: Partial<Parameters<Store['quotes']['request']>[0]> = {}) => ({
  items: [
    { sku: 'VDCTOYTAC9504', quantity: 40 },
    { sku: 'VDCHCIV0611', quantity: 12 },
  ],
  email: 'Buyer@Agency.gov',
  name: 'Sam Procurement',
  company: 'Field Office 7',
  phone: '+1 555 0199',
  message: 'Need delivery before the end of the fiscal year.',
  ...overrides,
})

const offer = {
  lines: [
    { sku: 'VDCTOYTAC9504', quantity: 40, unit_amount: { amount: 89900, currency: 'USD' } },
    { sku: 'VDCHCIV0611', quantity: 10, unit_amount: { amount: 79900, currency: 'USD' } },
  ],
  shipping: { amount: 25000, currency: 'USD' },
  tax: { amount: 0, currency: 'USD' },
  expires_at: '2026-10-13T12:00:00.000Z',
  note: 'Ships in 3 weeks. Net 30.',
}

describe('quote requests', () => {
  it('takes a guest request with no account, numbers it from Q1001 and emails buyer and merchant', async () => {
    const { store, mail } = rig({ QUOTE_NOTIFICATION_EMAIL: 'sales@store.test' })
    await seed(store)
    const quote = await store.quotes.request(guestRequest())

    expect(quote).toMatchObject({
      number: '1001',
      status: 'requested',
      currency: 'USD',
      company: 'Field Office 7',
      customer: { email: 'buyer@agency.gov', name: 'Sam Procurement', phone: '+1 555 0199' },
      total: null,
      orderId: null,
    })
    // Sold-out products may be quoted: lead time is part of the answer. The catalog price is kept for reference only.
    expect(quote.lines.map((l) => [l.sku, l.quantity, l.listAmount?.amount, l.unitAmount])).toEqual([
      ['VDCTOYTAC9504', 40, 109900, null],
      ['VDCHCIV0611', 12, 99500, null],
    ])
    expect(quote.accessKey).toMatch(/^[0-9a-f]{32}$/)
    expect(await store.quotes.getWithKey(quote.id, quote.accessKey)).toMatchObject({ id: quote.id })
    expect(await store.quotes.getWithKey(quote.id, 'wrong')).toBeNull()

    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ['buyer@agency.gov', 'Quote request Q1001 received — Test Store'],
      ['sales@store.test', 'New quote request Q1001 — Test Store'],
    ])
    expect(mail.sent[0]!.text).toContain(`https://store.test/quotes/${quote.id}/?key=${quote.accessKey}`)
    expect(mail.sent[1]!.replyTo).toBe('buyer@agency.gov')

    const second = await store.quotes.request(guestRequest({ items: [{ sku: 'VDCTOYSUP9302', quantity: 2 }] }))
    expect(second.number).toBe('1002')
    expect((await store.quotes.forCustomer(quote.customer.id)).map((q) => q.number)).toEqual(['1002', '1001'])
  })

  it('reports every problem at once and refuses unknown SKUs and silly quantities', async () => {
    const { store } = rig()
    await seed(store)
    await expect(store.quotes.request({ items: [], email: 'nope', name: '' })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { email: 'must be a valid email address', name: 'is required', items: 'is empty' },
    })
    await expect(
      store.quotes.request(guestRequest({ items: [{ sku: 'NOPE', quantity: 1 }, { sku: 'VDCTOYTAC9504', quantity: 0 }, { sku: 'VDCTOYTAC9504', quantity: 1.5 }] }))
    ).rejects.toMatchObject({
      details: { 'items.0.sku': 'is not a product in this store', 'items.1.quantity': 'must be a whole number from 1 to 100000', 'items.2.quantity': 'must be a whole number from 1 to 100000' },
    })
  })

  it('throttles one address after maxRequestsPerHour requests', async () => {
    const { store, clock } = rig({}, defineStorefront({ name: config.name, url: config.url, currency: config.currency, shipping: config.shipping, shipToCountries: config.shipToCountries, quotes: { maxRequestsPerHour: 2 } }))
    await seed(store)
    await store.quotes.request(guestRequest())
    await store.quotes.request(guestRequest())
    await expect(store.quotes.request(guestRequest())).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    await store.quotes.request(guestRequest({ email: 'other@agency.gov' }))
    clock.tick(3_600_001)
    await expect(store.quotes.request(guestRequest())).resolves.toMatchObject({ status: 'requested' })
  })
})

describe('quote offers and acceptance', () => {
  it('prices a quote, then the guest accepts it into a pay-later order at exactly the offered prices', async () => {
    const { store, mail } = rig({ QUOTE_NOTIFICATION_EMAIL: 'sales@store.test' })
    await seed(store)
    const requested = await store.quotes.request(guestRequest({ shippingAddress: usAddress }))
    await expect(store.quotes.accept(requested.id)).rejects.toMatchObject({ code: 'conflict', message: 'This quote has not been priced yet' })

    mail.sent.length = 0
    const quoted = await store.quotes.offer(requested.id, offer)
    expect(quoted).toMatchObject({
      status: 'quoted',
      subtotal: { amount: 89900 * 40 + 79900 * 10 },
      shipping: { amount: 25000 },
      total: { amount: 89900 * 40 + 79900 * 10 + 25000 },
      offerNote: 'Ships in 3 weeks. Net 30.',
      expiresAt: '2026-10-13T12:00:00.000Z',
    })
    expect(quoted.lines.map((l) => [l.sku, l.quantity, l.listAmount?.amount, l.unitAmount?.amount])).toEqual([
      ['VDCTOYTAC9504', 40, 109900, 89900],
      ['VDCHCIV0611', 10, 99500, 79900],
    ])
    expect(mail.sent.map((m) => m.subject)).toEqual(['Quote Q1001 is ready — Test Store'])
    expect(mail.sent[0]!.text).toContain('Ships in 3 weeks. Net 30.')

    mail.sent.length = 0
    const { quote, order } = await store.quotes.accept(requested.id, { poNumber: 'PO-77-1234' })
    expect(quote).toMatchObject({ status: 'accepted', orderId: order.id })
    expect(order).toMatchObject({
      status: 'pending_payment',
      payment: { status: 'unpaid', provider: 'manual' },
      subtotal: { amount: 89900 * 40 + 79900 * 10 },
      shipping: { amount: 25000 },
      total: { amount: 89900 * 40 + 79900 * 10 + 25000 },
      shippingAddress: { ...usAddress },
      shippingMethod: { code: 'quote', name: 'As quoted (Q1001)' },
      notes: 'PO PO-77-1234',
      metadata: { quote_id: requested.id, quote_number: 'Q1001', po_number: 'PO-77-1234' },
    })
    expect(order.lines.map((l) => [l.sku, l.quantity, l.unitAmount.amount])).toEqual([
      ['VDCTOYTAC9504', 40, 89900],
      ['VDCHCIV0611', 10, 79900],
    ])
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ['buyer@agency.gov', `Order ${order.number} received — Test Store`],
      ['sales@store.test', `Quote Q1001 accepted — order ${order.number} — Test Store`],
    ])

    // A double submit returns the same order rather than placing a second one.
    const again = await store.quotes.accept(requested.id)
    expect(again.order.id).toBe(order.id)
    expect(await store.orders.count()).toBe(1)
    // A pay-later order never expires as an abandoned checkout.
    expect(await store.orders.expireAbandoned({ olderThanMinutes: 0 })).toBe(0)
  })

  it('needs a shipping address by acceptance and takes one at that point', async () => {
    const { store } = rig()
    await seed(store)
    const requested = await store.quotes.request(guestRequest())
    await store.quotes.offer(requested.id, offer)
    await expect(store.quotes.accept(requested.id)).rejects.toMatchObject({ code: 'validation_failed', details: { 'shipping_address.line1': 'is required' } })
    expect((await store.quotes.require(requested.id)).status).toBe('quoted')
    const { order, quote } = await store.quotes.accept(requested.id, { shippingAddress: usAddress })
    expect(order.shippingAddress.city).toBe('Austin')
    expect(quote.shippingAddress?.city).toBe('Austin')
  })

  it('lapses an offer past its expiry, refuses to accept it, and lets the operations system renew it', async () => {
    const { store, clock } = rig()
    await seed(store)
    const requested = await store.quotes.request(guestRequest({ shippingAddress: usAddress }))
    await store.quotes.offer(requested.id, { ...offer, expires_at: '2026-09-14T12:00:00.000Z' })
    clock.tick(2 * 86_400_000)
    await expect(store.quotes.accept(requested.id)).rejects.toMatchObject({ code: 'conflict', message: 'This quote has expired; ask for it to be renewed' })
    expect((await store.quotes.require(requested.id)).status).toBe('expired')
    await store.quotes.offer(requested.id, { ...offer, expires_at: '2026-12-31T00:00:00.000Z' })
    await expect(store.quotes.accept(requested.id)).resolves.toMatchObject({ quote: { status: 'accepted' } })
  })

  it('declines, cancels and refuses the transitions that make no sense', async () => {
    const { store, mail } = rig({ ORDER_NOTIFICATION_EMAIL: 'orders@store.test' })
    await seed(store)
    const a = await store.quotes.request(guestRequest())
    await store.quotes.offer(a.id, offer)
    mail.sent.length = 0
    const declined = await store.quotes.decline(a.id, 'Found it cheaper')
    expect(declined).toMatchObject({ status: 'declined', declineReason: 'Found it cheaper' })
    // The merchant address falls back to ORDER_NOTIFICATION_EMAIL.
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([['orders@store.test', 'Quote Q1001 declined — Test Store']])
    await expect(store.quotes.offer(a.id, offer)).rejects.toMatchObject({ code: 'conflict' })
    await expect(store.quotes.accept(a.id)).rejects.toMatchObject({ code: 'conflict' })

    const b = await store.quotes.request(guestRequest({ email: 'b@agency.gov', shippingAddress: usAddress }))
    expect((await store.quotes.cancel(b.id, 'Discontinued')).status).toBe('cancelled')
    await expect(store.quotes.decline(b.id)).rejects.toMatchObject({ code: 'conflict' })

    const c = await store.quotes.request(guestRequest({ email: 'c@agency.gov', shippingAddress: usAddress }))
    await store.quotes.offer(c.id, offer)
    await store.quotes.accept(c.id)
    await expect(store.quotes.cancel(c.id)).rejects.toMatchObject({ code: 'conflict', message: 'An accepted quote has become an order; cancel the order instead' })
  })

  it('validates an offer: currency, duplicate lines, off-catalog names, an expiry in the past', async () => {
    const { store } = rig()
    await seed(store)
    const q = await store.quotes.request(guestRequest())
    await expect(
      store.quotes.offer(q.id, {
        lines: [
          { sku: 'VDCTOYTAC9504', quantity: 1, unit_amount: { amount: 1, currency: 'EUR' } },
          { sku: 'VDCTOYTAC9504', quantity: 1, unit_amount: { amount: 1, currency: 'USD' } },
          { sku: 'CUSTOM-KIT', quantity: 1, unit_amount: { amount: 1, currency: 'USD' } },
        ],
        expires_at: '2020-01-01T00:00:00.000Z',
      })
    ).rejects.toMatchObject({
      details: {
        'offer.lines.0.unit_amount.currency': 'must be USD',
        'offer.lines.1.sku': 'appears twice',
        'offer.lines.2.name': 'is required for a SKU this store does not list',
        'offer.expires_at': 'must be in the future',
      },
    })
    // An alternative the store does not list is fine with a name.
    const priced = await store.quotes.offer(q.id, { lines: [{ sku: 'CUSTOM-KIT', name: 'Custom kit, 40 doors', quantity: 1, unit_amount: { amount: 3_000_000, currency: 'USD' } }] })
    expect(priced.lines).toMatchObject([{ sku: 'CUSTOM-KIT', name: 'Custom kit, 40 doors', listAmount: null, unitAmount: { amount: 3_000_000 } }])
  })
})

describe('Store API quotes', () => {
  it('lists, fetches and prices quotes, and the accepted order arrives through GET /orders', async () => {
    const { store } = rig()
    await seed(store)
    const q = await store.quotes.request(guestRequest({ shippingAddress: usAddress }))
    const api = client(store)

    const list = await api('GET', '/quotes')
    expect(list.status).toBe(200)
    expect(list.body.next_cursor).toBeNull()
    expect(list.body.data).toHaveLength(1)
    const one = list.body.data[0]
    expect(one).toMatchObject({
      id: q.id,
      number: 'Q1001',
      status: 'requested',
      currency: 'USD',
      customer: { email: 'buyer@agency.gov', name: 'Sam Procurement' },
      company: 'Field Office 7',
      message: 'Need delivery before the end of the fiscal year.',
      shipping_address: { line1: '1 Analytical Way', postal_code: '78701', country: 'US' },
      lines: [
        { sku: 'VDCTOYTAC9504', quantity: 40, list_amount: { amount: 109900, currency: 'USD' }, unit_amount: null, total_amount: null },
        { sku: 'VDCHCIV0611', quantity: 12, list_amount: { amount: 99500, currency: 'USD' }, unit_amount: null, total_amount: null },
      ],
      total: null,
      order_id: null,
    })
    expect(JSON.stringify(one)).not.toContain(q.accessKey)

    const bad = await api('PATCH', `/quotes/${q.id}`, { offer: { lines: [{ sku: 'VDCTOYTAC9504', quantity: 0, unit_amount: { amount: 1.5, currency: 'USD' } }] } })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toMatchObject({ 'offer.lines.0.quantity': 'must be an integer of at least 1', 'offer.lines.0.unit_amount': expect.any(String) })

    const priced = await api('PATCH', `/quotes/${q.id}`, { external_reference: 'QT-000123', offer })
    expect(priced.status).toBe(200)
    expect(priced.body.data).toMatchObject({ status: 'quoted', external_reference: 'QT-000123', total: { amount: 89900 * 40 + 79900 * 10 + 25000, currency: 'USD' }, note: 'Ships in 3 weeks. Net 30.' })

    const since = await api('GET', `/quotes?updated_since=${encodeURIComponent(priced.body.data.updated_at)}`)
    expect(since.body.data.map((x: { id: string }) => x.id)).toEqual([q.id])

    const { order } = await store.quotes.accept(q.id)
    const fetched = await api('GET', `/quotes/${q.id}`)
    expect(fetched.body.data).toMatchObject({ status: 'accepted', order_id: order.id, accepted_at: expect.any(String) })
    const orders = await api('GET', '/orders')
    expect(orders.body.data).toMatchObject([{ id: order.id, metadata: { quote_id: q.id, quote_number: 'Q1001', quote_external_reference: 'QT-000123' } }])

    expect((await api('PATCH', `/quotes/${q.id}`, { status: 'cancelled' })).status).toBe(409)
    expect((await api('GET', '/quotes/quo_nope')).status).toBe(404)
    expect((await api('PATCH', `/quotes/${q.id}`, {})).status).toBe(422)
  })

  it('pages quotes by (updated_at, id) and expires lapsed offers before listing them', async () => {
    const { store, clock } = rig()
    await seed(store)
    const a = await store.quotes.request(guestRequest())
    const b = await store.quotes.request(guestRequest({ email: 'b@agency.gov' }))
    const api = client(store)
    const first = await api('GET', '/quotes?limit=1')
    expect(first.body.data.map((q: { id: string }) => q.id)).toEqual([a.id])
    const next = await api('GET', `/quotes?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(next.body.data.map((q: { id: string }) => q.id)).toEqual([b.id])
    expect((await api('GET', '/quotes?limit=500')).status).toBe(422)

    await store.quotes.offer(a.id, { ...offer, expires_at: '2026-09-14T00:00:00.000Z' })
    clock.tick(2 * 86_400_000)
    const listed = await api('GET', '/quotes')
    expect(listed.body.data.find((q: { id: string }) => q.id === a.id).status).toBe('expired')
  })

  it('needs the quotes scope on a connection', async () => {
    const { store } = rig()
    await seed(store)
    const request = store.connections.validateAuthorize({ client_id: 'skuio', redirect_uri: 'https://acme.sku.test/cb', state: 's', tenant: 'acme', scope: 'orders' })
    const approved = await store.connections.approve(request, null)
    const code = new URL(approved.redirectTo).searchParams.get('code')!
    const issued = await store.connections.exchange({ code, redirect_uri: 'https://acme.sku.test/cb' }, '1.2.3.4')
    const res = await handleStoreApi(new Request('https://store.test/api/store/v1/quotes', { headers: { authorization: `Bearer ${issued.apiKey}` } }), { store, apiKey: undefined })
    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toContain('"quotes"')
  })
})
