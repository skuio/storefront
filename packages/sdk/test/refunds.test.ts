import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { handleStoreApi, type StoreApiOptions } from '../src/api'
import { applyPaymentEvents, type PaymentAdapter } from '../src/payments'
import { manualPayments } from '../src/payments/manual'
import { paypalPayments } from '../src/payments/paypal'
import { eventsFromStripe, stripePayments } from '../src/payments/stripe'
import type { Store } from '../src/store'
import { placeOrder, rig, seed } from './helpers'

const KEY = 'k'.repeat(64)
const TOTAL = 109900

function client(store: Store, payments?: StoreApiOptions['payments']) {
  return async (method: string, path: string, body?: unknown, key: string = KEY) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const request = new Request(`https://store.test/api/store/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const response = await handleStoreApi(request, { store, apiKey: KEY, ...(payments ? { payments } : {}) })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}

/** A fake Stripe client: refunds.create answers from `answer`, every call recorded. */
function fakeStripe(answer: (params: Stripe.RefundCreateParams, n: number) => Partial<Stripe.Refund> | Error = (p, n) => ({ id: `re_${n}`, status: 'succeeded', amount: p.amount!, currency: 'usd' })) {
  const created: { params: Stripe.RefundCreateParams; options: Stripe.RequestOptions | undefined }[] = []
  const stripe = {
    refunds: {
      create: vi.fn(async (params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions) => {
        created.push({ params, options })
        const out = answer(params, created.length)
        if (out instanceof Error) throw out
        return { object: 'refund', metadata: params.metadata, payment_intent: params.payment_intent ?? null, charge: params.charge ?? null, ...out }
      }),
      retrieve: vi.fn(async (id: string) => ({ id, status: 'succeeded', amount: 0, currency: 'usd', metadata: {} })),
      list: vi.fn(async () => ({ data: [] as Partial<Stripe.Refund>[] })),
    },
    webhooks: { constructEventAsync: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
  }
  return { stripe: stripe as unknown as Stripe, raw: stripe, created }
}

async function paidOrder(provider = 'stripe', reference = 'pi_1') {
  const r = rig()
  await seed(r.store)
  const placed = await placeOrder(r.store)
  const order = await r.store.orders.markPaid(placed.id, { provider, reference, methodLabel: provider === 'paypal' ? 'PayPal' : 'Card' })
  return { ...r, order }
}

const usd = (amount: number) => ({ amount, currency: 'USD' })

describe('POST /orders/{id}/refunds — Stripe', () => {
  it('refunds through POST /v1/refunds with the Idempotency-Key and metadata, and shows it on the order', async () => {
    const { store, order, mail } = await paidOrder()
    const fake = fakeStripe()
    const api = client(store, () => [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])

    const before = await api('GET', `/orders/${order.id}`)
    expect(before.body.data.payment).toMatchObject({ refundable: true, refunded: usd(0), refundable_amount: usd(TOTAL) })
    expect(before.body.data.refunds).toEqual([])

    const res = await api('POST', `/orders/${order.id}/refunds`, {
      idempotency_key: 'sku-crr-1-1',
      amount: usd(1500),
      shipping: usd(0),
      lines: [{ sku: 'VDCTOYTAC9504', quantity: 1, amount: usd(1500) }],
      reason: 'Damaged in transit',
      note: 'customer sent photos',
      notify_customer: true,
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      id: expect.stringMatching(/^rf_/),
      order_id: order.id,
      status: 'succeeded',
      amount: usd(1500),
      shipping: usd(0),
      lines: [{ sku: 'VDCTOYTAC9504', quantity: 1, amount: usd(1500) }],
      reason: 'Damaged in transit',
      note: 'customer sent photos',
      provider: 'stripe',
      reference: 're_1',
      failure_reason: null,
      idempotency_key: 'sku-crr-1-1',
      source: 'api',
    })
    expect(fake.created).toHaveLength(1)
    const call = fake.created[0]!
    expect(call.params).toMatchObject({ payment_intent: 'pi_1', amount: 1500, metadata: { order_id: order.id, refund_id: res.body.data.id } })
    expect(call.options).toEqual({ idempotencyKey: `storefront-refund-${res.body.data.id}` })

    const after = await api('GET', `/orders/${order.id}`)
    expect(after.body.data.payment).toMatchObject({ status: 'paid', refundable: true, refunded: usd(1500), refundable_amount: usd(TOTAL - 1500) })
    expect(after.body.data.refunds).toEqual([res.body.data])
    expect(after.body.data.updated_at > order.updatedAt).toBe(true)

    // The buyer heard about it.
    expect(mail.sent.find((m) => m.subject.startsWith('Refund for order'))).toMatchObject({ to: order.customer.email })

    const list = await api('GET', `/orders/${order.id}/refunds`)
    expect(list.body.data).toEqual([res.body.data])
    const one = await api('GET', `/orders/${order.id}/refunds/${res.body.data.id}`)
    expect(one.body.data).toEqual(res.body.data)
    expect((await api('GET', `/orders/${order.id}/refunds/rf_nope`)).status).toBe(404)
  })

  it('replays the same idempotency key with 200 and never calls the processor twice — even after a failure', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe()
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    const body = { idempotency_key: 'sku-crr-7-1', amount: usd(2000) }
    const first = await api('POST', `/orders/${order.id}/refunds`, body)
    expect(first.status).toBe(201)
    const again = await api('POST', `/orders/${order.id}/refunds`, body)
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(first.body.data)
    // Even concurrent repeats.
    const both = await Promise.all([api('POST', `/orders/${order.id}/refunds`, body), api('POST', `/orders/${order.id}/refunds`, body)])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    expect(fake.raw.refunds.create).toHaveBeenCalledTimes(1)
    expect((await store.orders.require(order.id)).refunds).toHaveLength(1)
  })

  it('stores a processor refusal as a failed row and answers 502; the same key replays it without a second call', async () => {
    const { store, order, mail } = await paidOrder()
    const refusal = Object.assign(new Error('Charge ch_1 has already been refunded.'), { type: 'StripeInvalidRequestError', statusCode: 400, code: 'charge_already_refunded' })
    const fake = fakeStripe(() => refusal)
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    const res = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'k-1', amount: usd(1000), notify_customer: true })
    expect(res.status).toBe(502)
    expect(res.body.error).toMatchObject({ code: 'processor_error', message: 'Charge ch_1 has already been refunded.' })
    expect(res.body.data).toMatchObject({ status: 'failed', failure_reason: 'Charge ch_1 has already been refunded.', reference: null, amount: usd(1000) })
    expect(mail.sent.some((m) => m.subject.startsWith('Refund'))).toBe(false)

    const stored = await store.orders.require(order.id)
    expect(stored.refunds).toMatchObject([{ status: 'failed' }])
    // A failed refund holds nothing back.
    expect((await api('GET', `/orders/${order.id}`)).body.data.payment).toMatchObject({ refunded: usd(0), refundable_amount: usd(TOTAL) })

    const replay = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'k-1', amount: usd(1000) })
    expect(replay.status).toBe(200)
    expect(replay.body.data).toMatchObject({ id: res.body.data.id, status: 'failed' })
    expect(fake.raw.refunds.create).toHaveBeenCalledTimes(1)
  })

  it('records a thrown processor error (unknown outcome) as failed too', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe(() => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    const res = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'k-x', amount: usd(1000) })
    expect(res.status).toBe(502)
    expect(res.body.data).toMatchObject({ status: 'failed', failure_reason: 'socket hang up' })
  })

  it('refuses more than is left to refund with 422, including two concurrent requests that each fit alone', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe()
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    const over = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'a', amount: usd(TOTAL + 1) })
    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('validation_failed')
    expect(over.body.error.details.amount).toMatch(/exceeds the refundable 109900/)

    const sixty = Math.round(TOTAL * 0.6)
    const raced = await Promise.all([
      api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'b', amount: usd(sixty) }),
      api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'c', amount: usd(sixty) }),
    ])
    expect(raced.map((r) => r.status).sort()).toEqual([201, 422])
    expect(fake.raw.refunds.create).toHaveBeenCalledTimes(1)
    const refunded = (await api('GET', `/orders/${order.id}`)).body.data.payment
    expect(refunded).toMatchObject({ refunded: usd(sixty), refundable_amount: usd(TOTAL - sixty) })
  })

  it('validates the body and checks it against the order', async () => {
    const { store, order } = await paidOrder()
    const api = client(store, [stripePayments({ stripe: fakeStripe().stripe, webhookSecret: 'whsec' })])
    const bad = await api('POST', `/orders/${order.id}/refunds`, { amount: { amount: 0, currency: 'USD' }, reason: 'x'.repeat(256), note: 'y'.repeat(1001) })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toMatchObject({ idempotency_key: 'is required', amount: 'must be greater than zero', reason: expect.any(String), note: expect.any(String) })
    const mismatch = await api('POST', `/orders/${order.id}/refunds`, {
      idempotency_key: 'm',
      amount: { amount: 100, currency: 'EUR' },
      lines: [{ sku: 'NOPE', quantity: 1, amount: { amount: 100, currency: 'EUR' } }, { sku: 'VDCTOYTAC9504', quantity: 5, amount: { amount: 100, currency: 'USD' } }],
    })
    expect(mismatch.status).toBe(422)
    expect(mismatch.body.error.details).toMatchObject({ 'amount.currency': expect.stringContaining('USD'), 'lines.0.sku': 'is not on this order', 'lines.1.quantity': 'exceeds the 1 ordered' })
    const shipping = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 's', amount: usd(100), shipping: usd(200) })
    expect(shipping.status).toBe(422)
    expect(shipping.body.error.details.shipping).toBe('must not be more than amount')
  })

  it('flips payment.status to refunded once the succeeded refunds reach what was received', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe()
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    expect((await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: '1', amount: usd(TOTAL - 900) })).status).toBe(201)
    expect((await store.orders.require(order.id)).payment.status).toBe('paid')
    expect((await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: '2', amount: usd(900) })).status).toBe(201)
    const done = (await api('GET', `/orders/${order.id}`)).body.data
    expect(done.status).toBe('refunded')
    expect(done.payment).toMatchObject({ status: 'refunded', refundable: false, refunded: usd(TOTAL), refundable_amount: usd(0) })
    const more = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: '3', amount: usd(1) })
    expect(more.status).toBe(409)
    expect(more.body.error.code).toBe('refund_unsupported')
    expect((await store.events.list(order.id)).map((e) => e.type)).toEqual(expect.arrayContaining(['refund_succeeded', 'refunded']))
  })
})

describe('POST /orders/{id}/refunds — PayPal', () => {
  it('refunds the capture with PayPal-Request-Id, keeps a PENDING refund pending, and re-checks it on GET', async () => {
    const { store, order } = await paidOrder('paypal', 'CAP1')
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
    let refundStatus = 'PENDING'
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      calls.push({ url, method, headers, body: typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null })
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'T', expires_in: 3600 })
      if (method === 'POST' && url.endsWith('/v2/payments/captures/CAP1/refund')) return Response.json({ id: 'PPR1', status: 'PENDING', amount: { value: '25.00', currency_code: 'USD' } }, { status: 201 })
      if (method === 'GET' && url.endsWith('/v2/payments/refunds/PPR1')) return Response.json({ id: 'PPR1', status: refundStatus, amount: { value: '25.00', currency_code: 'USD' } })
      return new Response('no route', { status: 599 })
    })
    const api = client(store, [paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch: fetch as unknown as typeof globalThis.fetch })])

    const res = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'sku-crr-9-1', amount: usd(2500), reason: 'Return' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ status: 'pending', provider: 'paypal', reference: 'PPR1' })
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/refund'))!
    expect(post.headers['paypal-request-id']).toBe(`storefront-refund-${res.body.data.id}`)
    expect(post.body).toMatchObject({ amount: { value: '25.00', currency_code: 'USD' }, custom_id: res.body.data.id, note_to_payer: 'Return' })

    // Pending counts against what is left.
    expect((await api('GET', `/orders/${order.id}`)).body.data.payment).toMatchObject({ refunded: usd(2500), refundable_amount: usd(TOTAL - 2500) })

    // Still pending at PayPal: stays pending. Then completed: the GET picks it up.
    expect((await api('GET', `/orders/${order.id}/refunds/${res.body.data.id}`)).body.data.status).toBe('pending')
    refundStatus = 'COMPLETED'
    expect((await api('GET', `/orders/${order.id}/refunds`)).body.data[0]).toMatchObject({ status: 'succeeded', reference: 'PPR1' })
  })

  it('stores a PayPal 422 as a failed refund with the issue', async () => {
    const { store, order } = await paidOrder('paypal', 'CAP1')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'T', expires_in: 3600 })
      return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'CAPTURE_FULLY_REFUNDED', description: 'The capture has already been fully refunded' }] }, { status: 422 })
    })
    const api = client(store, [paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch: fetch as unknown as typeof globalThis.fetch })])
    const res = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'p', amount: usd(100) })
    expect(res.status).toBe(502)
    expect(res.body.data).toMatchObject({ status: 'failed', failure_reason: 'CAPTURE_FULLY_REFUNDED: The capture has already been fully refunded' })
  })
})

describe('refunds: support and scope', () => {
  it('409s an order whose processor cannot refund (manual), and one that is not paid', async () => {
    const { store, order } = await paidOrder('manual', 'wire-1')
    const api = client(store, [manualPayments(), stripePayments({ stripe: fakeStripe().stripe, webhookSecret: 'whsec' })])
    expect((await api('GET', `/orders/${order.id}`)).body.data.payment.refundable).toBe(false)
    const res = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'x', amount: usd(100) })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('refund_unsupported')

    const unpaid = await placeOrder(store)
    const api2 = client(store, [stripePayments({ stripe: fakeStripe().stripe, webhookSecret: 'whsec' })])
    expect((await api2('POST', `/orders/${unpaid.id}/refunds`, { idempotency_key: 'y', amount: usd(100) })).body.error.code).toBe('refund_unsupported')
    // A store with no payment adapters at all: nothing is refundable.
    const { store: s2, order: o2 } = await paidOrder()
    const bare = client(s2)
    expect((await bare('GET', `/orders/${o2.id}`)).body.data.payment.refundable).toBe(false)
    expect((await bare('POST', `/orders/${o2.id}/refunds`, { idempotency_key: 'z', amount: usd(100) })).status).toBe(409)
  })

  it('needs the refunds scope to POST (403 without it); reading refunds needs only orders', async () => {
    const { store, order } = await paidOrder()
    const api = client(store, [stripePayments({ stripe: fakeStripe().stripe, webhookSecret: 'whsec' })])
    async function keyWith(scope: string): Promise<string> {
      const request = store.connections.validateAuthorize({ client_id: 'skuio', redirect_uri: 'https://acme.sku.test/cb', state: 's', tenant: 'acme', scope })
      const approved = await store.connections.approve(request, null)
      const code = new URL(approved.redirectTo).searchParams.get('code')!
      const res = await api('POST', '/connect/token', { code, redirect_uri: 'https://acme.sku.test/cb' })
      return res.body.data.api_key as string
    }
    const ordersOnly = await keyWith('orders')
    const denied = await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'a', amount: usd(100) }, ordersOnly)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({ code: 'forbidden', message: expect.stringContaining('"refunds"') })
    expect((await api('GET', `/orders/${order.id}/refunds`, undefined, ordersOnly)).status).toBe(200)

    const withRefunds = await keyWith('orders,refunds')
    expect((await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'a', amount: usd(100) }, withRefunds)).status).toBe(201)
    expect((await api('GET', '/connect', undefined, withRefunds)).body.data.scopes).toEqual(['orders', 'refunds'])
  })
})

describe('refunds reported by the processor (webhooks)', () => {
  it('a partial refund webhook updates the row the Store API made, found by the refund id in its metadata', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe((p) => ({ id: 're_9', status: 'pending', amount: p.amount!, currency: 'usd' }))
    const api = client(store, [stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })])
    const made = (await api('POST', `/orders/${order.id}/refunds`, { idempotency_key: 'w', amount: usd(3000) })).body.data
    expect(made.status).toBe('pending')

    const event = { type: 'charge.refund.updated', data: { object: { id: 're_9', object: 'refund', status: 'succeeded', amount: 3000, currency: 'usd', payment_intent: 'pi_1', charge: 'ch_1', metadata: { order_id: order.id, refund_id: made.id } } } }
    const events = eventsFromStripe(event as unknown as Stripe.Event)
    expect(events).toMatchObject([{ type: 'refund', orderId: order.id, provider: 'stripe', paymentReference: 'pi_1', refund: { reference: 're_9', status: 'succeeded', refundId: made.id, amount: { amount: 3000 } } }])
    await applyPaymentEvents(store, events)
    const after = await store.orders.require(order.id)
    expect(after.refunds).toMatchObject([{ id: made.id, status: 'succeeded', source: 'api' }])
    expect(after.payment.status).toBe('paid')
    // Redelivery changes nothing.
    await applyPaymentEvents(store, events)
    expect((await store.orders.require(order.id)).refunds).toHaveLength(1)
  })

  it('a refund made in the Stripe dashboard (charge.refunded, partial) is listed and inserted with source "processor"', async () => {
    const { store, order } = await paidOrder()
    const fake = fakeStripe()
    const charge = { id: 'ch_1', object: 'charge', refunded: false, amount_refunded: 4000, payment_intent: 'pi_1', metadata: {} }
    fake.raw.webhooks.constructEventAsync.mockResolvedValue({ type: 'charge.refunded', data: { object: charge } })
    fake.raw.refunds.list.mockResolvedValue({ data: [{ id: 're_dash', object: 'refund', status: 'succeeded', amount: 4000, currency: 'usd', payment_intent: 'pi_1', charge: 'ch_1', metadata: {}, reason: 'requested_by_customer' }] })
    const adapter = stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })
    const request = () => new Request('https://store.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: '{}' })
    const events = await adapter.handleWebhook(request(), { store, siteUrl: 'https://store.test' })
    expect(fake.raw.refunds.list).toHaveBeenCalledWith({ charge: 'ch_1', limit: 100 })
    await applyPaymentEvents(store, events)
    const after = await store.orders.require(order.id)
    expect(after.refunds).toMatchObject([{ status: 'succeeded', source: 'processor', reference: 're_dash', amount: { amount: 4000 }, reason: 'requested_by_customer', idempotencyKey: 'processor:re_dash' }])
    expect(after.payment.status).toBe('paid')
    expect(after.updatedAt > order.updatedAt).toBe(true)
    // Delivered again (and as charge.refund.updated): still one row.
    await applyPaymentEvents(store, await adapter.handleWebhook(request(), { store, siteUrl: 'https://store.test' }))
    expect((await store.orders.require(order.id)).refunds).toHaveLength(1)

    // The Store API counts it against what is left.
    const api = client(store, [adapter])
    expect((await api('GET', `/orders/${order.id}`)).body.data.payment).toMatchObject({ refunded: usd(4000), refundable_amount: usd(TOTAL - 4000) })
  })

  it('a full dashboard refund inserts the row and flips the payment to refunded, with the ledger booked once', async () => {
    const { store, order, db } = await paidOrder()
    const fake = fakeStripe()
    const charge = { id: 'ch_1', object: 'charge', refunded: true, amount_refunded: TOTAL, payment_intent: 'pi_1', metadata: { order_id: order.id } }
    fake.raw.webhooks.constructEventAsync.mockResolvedValue({ type: 'charge.refunded', data: { object: charge } })
    fake.raw.refunds.list.mockResolvedValue({ data: [{ id: 're_all', object: 'refund', status: 'succeeded', amount: TOTAL, currency: 'usd', payment_intent: 'pi_1', charge: 'ch_1', metadata: {} }] })
    const adapter = stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })
    const events = await adapter.handleWebhook(new Request('https://store.test/w', { method: 'POST', headers: { 'stripe-signature': 's' }, body: '{}' }), { store, siteUrl: 'https://store.test' })
    expect(events.map((e) => e.type)).toEqual(['refund', 'refunded'])
    await applyPaymentEvents(store, events)
    const after = await store.orders.require(order.id)
    expect(after.payment.status).toBe('refunded')
    expect(after.status).toBe('refunded')
    expect(after.refunds).toMatchObject([{ source: 'processor', status: 'succeeded' }])
    const ledger = await db.prepare(`SELECT SUM(amount) AS n FROM payments WHERE order_id = ? AND status = 'refunded'`).bind(order.id).first<{ n: number }>()
    expect(ledger!.n).toBe(-TOTAL)
  })

  it('a PayPal PAYMENT.CAPTURE.REFUNDED for a partial dashboard refund is recorded', async () => {
    const { store, order } = await paidOrder('paypal', 'CAP1')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'T', expires_in: 3600 })
      if (url.endsWith('/v1/notifications/verify-webhook-signature')) return Response.json({ verification_status: 'SUCCESS' })
      if (url.endsWith('/v2/payments/captures/CAP1')) return Response.json({ id: 'CAP1', status: 'PARTIALLY_REFUNDED', custom_id: order.id })
      return new Response('no route', { status: 599 })
    })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch: fetch as unknown as typeof globalThis.fetch })
    const body = { event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'PPR7', status: 'COMPLETED', amount: { value: '10.50', currency_code: 'USD' }, links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1' }] } }
    const request = new Request('https://store.test/w', { method: 'POST', headers: { 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's' }, body: JSON.stringify(body) })
    const events = await adapter.handleWebhook(request, { store, siteUrl: 'https://store.test' })
    expect(events).toMatchObject([{ type: 'refund', orderId: order.id, refund: { reference: 'PPR7', status: 'succeeded', amount: { amount: 1050, currency: 'usd' } } }])
    await applyPaymentEvents(store, events)
    const after = await store.orders.require(order.id)
    expect(after.refunds).toMatchObject([{ source: 'processor', reference: 'PPR7', amount: { amount: 1050 } }])
    expect(after.payment.status).toBe('paid')
  })

  it('ignores a processor refund that matches no order', async () => {
    const { store } = await paidOrder()
    const touched = await applyPaymentEvents(store, [
      { type: 'refund', orderId: null, provider: 'stripe', paymentReference: 'pi_other', refund: { reference: 're_x', status: 'succeeded', amount: { amount: 1, currency: 'usd' } } },
    ])
    expect(touched).toEqual([])
  })
})

describe('adapters without refund()', () => {
  it('manual declares none', () => {
    const adapter: PaymentAdapter = manualPayments()
    expect(adapter.refund).toBeUndefined()
  })
})
