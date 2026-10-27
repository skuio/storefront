import { describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import { defineStorefront, flatRate, freeShipping } from '../src'
import { applyPaymentEvents, PaymentWebhookError } from '../src/payments'
import { btcpayPayments, validSignature } from '../src/payments/btcpay'
import { decimal, paypalExpress, paypalPayments } from '../src/payments/paypal'
import { eventsFromStripe, settlementOf, stripeExpress, stripePayments } from '../src/payments/stripe'
import { placeOrder, rig, seed } from './helpers'

const config = defineStorefront({
  name: 'Test Store',
  url: 'https://store.test',
  currency: 'usd',
  shipping: [freeShipping('us', 'Free shipping', { countries: ['US'] }), flatRate('intl', 'International', { amount: 4000, currency: 'usd' })],
  shipToCountries: ['US', 'CA'],
  discounts: [{ code: 'PODCAST', percentOff: 10, partner: 'pod', commissionPercent: 15 }],
})

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }

/** A fetch that answers from a route table and records every call. */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const raw = typeof init?.body === 'string' ? init.body : null
    const call = { url, method, headers, body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw }
    calls.push(call)
    const key = Object.keys(routes).find((k) => `${method} ${url}`.includes(k))
    if (!key) return new Response(`no route for ${method} ${url}`, { status: 599 })
    const out = routes[key]!(call)
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), { status: out.status ?? 200 })
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

async function discountedOrder() {
  const r = rig({ SESSION_SECRET: 's' }, config)
  await seed(r.store)
  const order = await placeOrder(r.store, { discountCode: 'podcast' })
  return { ...r, order, ctx: { store: r.store, siteUrl: 'https://store.test' } }
}

describe('paypal adapter', () => {
  const token = { 'POST https://api-m.sandbox.paypal.com/v1/oauth2/token': () => ({ body: { access_token: 'A', expires_in: 3600 } }) }

  it('creates an order with the store total, discount and address, and redirects to approval', async () => {
    const { order, ctx } = await discountedOrder()
    const { fetch, calls } = fakeFetch({
      ...token,
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders': () => ({ body: { id: 'PP1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' }] } }),
    })
    const start = await paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch }).start(order, ctx)
    expect(start).toEqual({ kind: 'redirect', url: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' })
    const body = calls[1]!.body as any
    expect(body.purchase_units[0].custom_id).toBe(order.id)
    expect(body.purchase_units[0].amount).toEqual({
      currency_code: 'USD',
      value: '989.10',
      breakdown: { item_total: { currency_code: 'USD', value: '1099.00' }, shipping: { currency_code: 'USD', value: '0.00' }, discount: { currency_code: 'USD', value: '109.90' } },
    })
    expect(body.purchase_units[0].shipping.address).toMatchObject({ address_line_1: '1 Analytical Way', country_code: 'US' })
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('SET_PROVIDED_ADDRESS')
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa('c:s')}`)
  })

  it('captures on return, and only for its own order', async () => {
    const { store, order } = await discountedOrder()
    const completed = { id: 'PP1', status: 'COMPLETED', purchase_units: [{ custom_id: order.id, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '989.10' } }] } }] }
    const { fetch, calls } = fakeFetch({
      ...token,
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders/PP1/capture': () => ({ body: completed }),
      'GET https://api-m.sandbox.paypal.com/v2/checkout/orders/PP1': () => ({ body: { id: 'PP1', status: 'APPROVED', purchase_units: [{ custom_id: order.id }] } }),
    })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const events = await adapter.verifyReturn!(new URLSearchParams('token=PP1'), order, { store, siteUrl: '' })
    expect(events).toMatchObject([{ type: 'paid', orderId: order.id, reference: 'CAP1', amount: { amount: 98910, currency: 'usd' } }])
    expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(true)
    const [paid] = await applyPaymentEvents(store, events)
    expect(paid).toMatchObject({ status: 'paid', discountCode: 'PODCAST', total: { amount: 98910 } })

    const other = await placeOrder(store)
    expect(await adapter.verifyReturn!(new URLSearchParams('token=PP1'), other, { store, siteUrl: '' })).toEqual([])
  })

  it('refuses a webhook PayPal does not verify, and captures an approved order it does', async () => {
    const { store, order } = await discountedOrder()
    let verdict = 'FAILURE'
    const { fetch } = fakeFetch({
      ...token,
      'POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature': () => ({ body: { verification_status: verdict } }),
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders/PP9/capture': () => ({
        body: { id: 'PP9', status: 'COMPLETED', purchase_units: [{ custom_id: order.id, payments: { captures: [{ id: 'CAP9', status: 'COMPLETED', amount: { currency_code: 'USD', value: '989.10' } }] } }] },
      }),
    })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const req = () =>
      new Request('https://store.test/api/payments/webhook?provider=paypal', {
        method: 'POST',
        headers: { 'paypal-transmission-id': 't', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'u', 'paypal-auth-algo': 'SHA256withRSA' },
        body: JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'PP9', purchase_units: [{ custom_id: order.id }] } }),
      })
    await expect(adapter.handleWebhook(req(), { store, siteUrl: '' })).rejects.toBeInstanceOf(PaymentWebhookError)
    verdict = 'SUCCESS'
    expect(await adapter.handleWebhook(req(), { store, siteUrl: '' })).toMatchObject([{ type: 'paid', orderId: order.id, reference: 'CAP9' }])
  })

  it('never captures an approved express order that no store order owns yet', async () => {
    const { store } = await discountedOrder()
    const { fetch, calls } = fakeFetch({
      ...token,
      'POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature': () => ({ body: { verification_status: 'SUCCESS' } }),
    })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const req = new Request('https://store.test/api/payments/webhook?provider=paypal', {
      method: 'POST',
      headers: { 'paypal-transmission-id': 't', 'paypal-transmission-sig': 'sig' },
      body: JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'PPX', purchase_units: [{ reference_id: 'default' }] } }),
    })
    expect(await adapter.handleWebhook(req, { store, siteUrl: '' })).toMatchObject([{ type: 'ignored' }])
    expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(false)
  })

  it('express: prices from the store quote, reprices by country, reads the buyer, links and captures', async () => {
    const { store } = await discountedOrder()
    const { fetch, calls } = fakeFetch({
      ...token,
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders/PPE/capture': () => ({
        body: { id: 'PPE', status: 'COMPLETED', purchase_units: [{ custom_id: 'ORD', payments: { captures: [{ id: 'CAPE', status: 'COMPLETED', custom_id: 'ORD', amount: { currency_code: 'USD', value: '1029.10' } }] } }] },
      }),
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders': () => ({ body: { id: 'PPE', status: 'CREATED' } }),
      'PATCH https://api-m.sandbox.paypal.com/v2/checkout/orders/PPE': () => ({ body: '' }),
      'GET https://api-m.sandbox.paypal.com/v2/checkout/orders/PPE': () => ({
        body: {
          id: 'PPE',
          status: 'APPROVED',
          payer: { email_address: 'buyer@example.com', name: { given_name: 'Ada', surname: 'Lovelace' } },
          purchase_units: [{ amount: { currency_code: 'USD', value: '1029.10' }, shipping: { name: { full_name: 'Ada Lovelace' }, address: { address_line_1: '1 Way', admin_area_2: 'Toronto', admin_area_1: 'ON', postal_code: 'M5V 2T6', country_code: 'CA' } } }],
        },
      }),
    })
    const x = paypalExpress({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const items = [{ sku: 'VDCTOYTAC9504', quantity: 1 }]
    const us = await store.checkout.quoteDefault(items, 'US', 'podcast')
    expect(await x.create(us, { brandName: 'Test Store' })).toBe('PPE')
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/checkout/orders'))!.body as any
    expect(created.purchase_units[0].custom_id).toBeUndefined() // unlinked until a store order exists
    expect(created.payment_source.paypal.experience_context.shipping_preference).toBe('GET_FROM_FILE')
    expect(created.purchase_units[0].amount).toMatchObject({ value: '989.10', breakdown: { item_total: { value: '1099.00' }, discount: { value: '109.90' }, shipping: { value: '0.00' } } })

    const ca = await store.checkout.quoteDefault(items, 'CA', 'podcast')
    await x.reprice('PPE', ca)
    const patch = calls.filter((c) => c.method === 'PATCH').at(-1)!.body as any
    expect(JSON.parse(patch as string)[0].value).toMatchObject({ value: '1029.10', breakdown: { shipping: { value: '40.00' } } })

    const buyer = await x.buyer('PPE')
    expect(buyer).toMatchObject({ email: 'buyer@example.com', name: 'Ada Lovelace', shippingAddress: { line1: '1 Way', city: 'Toronto', state: 'ON', country: 'CA' }, amount: { amount: 102910 } })

    const order = await store.checkout.createOrder({ items, email: buyer.email, name: buyer.name, shippingAddress: buyer.shippingAddress, shippingOptionId: ca.option.id, discountCode: 'podcast', walletContact: true })
    expect(order.total.amount).toBe(buyer.amount.amount)
    await x.attach('PPE', order, 'T-')
    const link = JSON.parse(calls.filter((c) => c.method === 'PATCH').at(-1)!.body as string)
    expect(link[0]).toMatchObject({ op: 'add', value: order.id })
    expect(await x.capture('PPE')).toMatchObject([{ type: 'paid', reference: 'CAPE' }])
  })

  it('formats amounts in major units', () => {
    expect([decimal(98910, 'usd'), decimal(5, 'usd'), decimal(1500, 'jpy')]).toEqual(['989.10', '0.05', '1500'])
  })
})

describe('btcpay adapter', () => {
  const server = 'https://btcpay.test'
  const settled = (orderId: string) => ({ id: 'INV1', status: 'Settled', amount: '989.10', currency: 'USD', checkoutLink: `${server}/i/INV1`, metadata: { orderId } })

  it('creates an invoice for the order total and redirects to it', async () => {
    const { order, ctx } = await discountedOrder()
    const { fetch, calls } = fakeFetch({ [`POST ${server}/api/v1/stores/S1/invoices`]: () => ({ body: { ...settled(order.id), status: 'New' } }) })
    const start = await btcpayPayments({ serverUrl: server, storeId: 'S1', apiKey: 'K', webhookSecret: 'w', fetch }).start(order, ctx)
    expect(start).toEqual({ kind: 'redirect', url: `${server}/i/INV1` })
    expect(calls[0]!.headers.authorization).toBe('token K')
    expect(calls[0]!.body).toMatchObject({ amount: '989.10', currency: 'USD', metadata: { orderId: order.id }, checkout: { redirectAutomatically: true } })
  })

  it('verifies the HMAC, then trusts only the invoice it reads back', async () => {
    const { store, order } = await discountedOrder()
    let invoice: Record<string, unknown> = { ...settled(order.id), status: 'Processing' }
    const { fetch } = fakeFetch({ [`GET ${server}/api/v1/stores/S1/invoices/INV1`]: () => ({ body: invoice }) })
    const adapter = btcpayPayments({ serverUrl: server, storeId: 'S1', apiKey: 'K', webhookSecret: 'whs', fetch })
    const body = JSON.stringify({ type: 'InvoiceSettled', invoiceId: 'INV1', storeId: 'S1' })
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode('whs'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = 'sha256=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const req = (s: string) => new Request('https://store.test/x', { method: 'POST', headers: { 'btcpay-sig': s }, body })

    await expect(adapter.handleWebhook(req('sha256=00'), { store, siteUrl: '' })).rejects.toBeInstanceOf(PaymentWebhookError)
    // The body claims Settled; the API says Processing — nothing happens.
    expect(await adapter.handleWebhook(req(sig), { store, siteUrl: '' })).toMatchObject([{ type: 'ignored' }])
    invoice = settled(order.id)
    const events = await adapter.handleWebhook(req(sig), { store, siteUrl: '' })
    expect(events).toMatchObject([{ type: 'paid', orderId: order.id, reference: 'INV1', methodLabel: 'Bitcoin', amount: { amount: 98910 } }])
    expect((await applyPaymentEvents(store, events))[0]).toMatchObject({ status: 'paid', partner: { id: 'pod' } })
    expect(await validSignature('whs', body, sig)).toBe(true)
  })
})

describe('btcpay late payments', () => {
  it('treats an expired invoice paid late as paid', async () => {
    const { store, order } = await discountedOrder()
    const server = 'https://btcpay.test'
    const { fetch } = fakeFetch({
      [`GET ${server}/api/v1/stores/S1/invoices?orderId=`]: () => ({
        body: [{ id: 'INV2', status: 'Expired', additionalStatus: 'PaidLate', amount: '989.10', currency: 'USD', checkoutLink: '', metadata: { orderId: order.id } }],
      }),
    })
    const adapter = btcpayPayments({ serverUrl: server, storeId: 'S1', apiKey: 'K', webhookSecret: 'w', fetch })
    expect(await adapter.verifyReturn!(new URLSearchParams(), order, { store, siteUrl: '' })).toMatchObject([{ type: 'paid', reference: 'INV2' }])
  })
})

describe('stripe adapter with a store discount', () => {
  it('carries the discount on a single-use coupon instead of promotion codes', async () => {
    const { order, ctx } = await discountedOrder()
    const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x', params }))
    const coupons = { create: vi.fn(async () => ({ id: 'co_1' })) }
    const stripe = { checkout: { sessions: { create } }, coupons } as unknown as Stripe
    await stripePayments({ stripe, webhookSecret: 'x' }).start(order, ctx)
    expect(coupons.create).toHaveBeenCalledWith(expect.objectContaining({ amount_off: 10990, max_redemptions: 1, name: 'PODCAST' }))
    const params = create.mock.calls[0]![0]
    expect(params.discounts).toEqual([{ coupon: 'co_1' }])
    expect(params).not.toHaveProperty('allow_promotion_codes')
  })
})

describe('stripe express', () => {
  const ev = (type: string, object: unknown) => ({ type, data: { object } }) as unknown as Stripe.Event

  it('makes an intent for exactly the order total, tagged express', async () => {
    const { order, ctx } = await discountedOrder()
    const create = vi.fn(async (params: Stripe.PaymentIntentCreateParams) => ({ id: 'pi_x', client_secret: 'pi_x_secret', ...params }))
    const stripe = { paymentIntents: { create } } as unknown as Stripe
    const out = await stripeExpress({ stripe }).intent(order, ctx)
    expect(out).toEqual({ clientSecret: 'pi_x_secret', paymentIntentId: 'pi_x' })
    const [params, opts] = create.mock.calls[0]! as unknown as [Stripe.PaymentIntentCreateParams, Stripe.RequestOptions]
    expect(params).toMatchObject({
      amount: order.total.amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      receipt_email: order.customer.email,
      metadata: { order_id: order.id, order_number: order.number, checkout: 'express' },
      shipping: { address: { line1: order.shippingAddress.line1, country: order.shippingAddress.country } },
    })
    expect(opts.idempotencyKey).toBe(`express-${order.id}-${order.updatedAt}`)
  })

  it('pays an order from an express intent, and only an express intent', () => {
    const pi = (metadata: Record<string, string>, extra: Record<string, unknown> = {}) => ({ id: 'pi_1', currency: 'usd', amount: 98910, amount_received: 98910, payment_method_types: ['card'], status: 'succeeded', metadata, ...extra })
    expect(eventsFromStripe(ev('payment_intent.succeeded', pi({ order_id: 'ord_1', checkout: 'express' })))).toEqual([
      expect.objectContaining({ type: 'paid', orderId: 'ord_1', provider: 'stripe', reference: 'pi_1', methodLabel: 'Card', amount: { amount: 98910, currency: 'usd' } }),
    ])
    // A hosted Checkout intent also carries order_id; its session event pays it, so this one must not.
    expect(eventsFromStripe(ev('payment_intent.succeeded', pi({ order_id: 'ord_1' })))).toEqual([{ type: 'ignored', reason: expect.stringContaining('Checkout session') }])
    expect(eventsFromStripe(ev('payment_intent.payment_failed', pi({ order_id: 'ord_1', checkout: 'express' }, { last_payment_error: { code: 'card_declined' } })))).toEqual([
      { type: 'failed', orderId: 'ord_1', provider: 'stripe', reference: 'pi_1', reason: 'card_declined' },
    ])
    expect(eventsFromStripe(ev('payment_intent.payment_failed', pi({ order_id: 'ord_1' })))).toEqual([{ type: 'ignored', reason: expect.stringContaining('Checkout session') }])
    expect(eventsFromStripe(ev('payment_intent.succeeded', pi({ checkout: 'express' })))).toEqual([{ type: 'ignored', reason: expect.stringContaining('no order id') }])
  })

  it('confirms an express return from the payment_intent parameter', async () => {
    const { order, ctx } = await discountedOrder()
    let status = 'processing'
    let orderId = order.id
    const retrieve = vi.fn(async () => ({ id: 'pi_9', currency: 'usd', amount: order.total.amount, amount_received: order.total.amount, payment_method_types: ['card'], status, metadata: { order_id: orderId, checkout: 'express' } }))
    const stripe = { paymentIntents: { retrieve } } as unknown as Stripe
    const adapter = stripePayments({ stripe, webhookSecret: 'x' })
    const params = new URLSearchParams({ payment_intent: 'pi_9', redirect_status: 'succeeded' })
    expect(await adapter.verifyReturn!(params, order, ctx)).toEqual([])
    status = 'succeeded'
    expect(await adapter.verifyReturn!(params, order, ctx)).toMatchObject([{ type: 'paid', orderId: order.id, reference: 'pi_9' }])
    orderId = 'ord_other'
    expect(await adapter.verifyReturn!(params, order, ctx)).toEqual([])
    expect(retrieve).toHaveBeenCalledWith('pi_9', { expand: ['latest_charge.balance_transaction'] })
  })
})

describe('processor fees (payment settlement)', () => {
  const expanded = (overrides: Record<string, unknown> = {}, bt: unknown = { id: 'txn_1', fee: 2898, net: 96012, currency: 'usd' }) => ({
    id: 'pi_1',
    status: 'succeeded',
    currency: 'usd',
    amount: 98910,
    amount_received: 98910,
    payment_method_types: ['card'],
    metadata: {},
    latest_charge: { id: 'ch_1', amount_captured: 98910, balance_transaction: bt },
    ...overrides,
  })

  it('stripe: reads amount, fee, net and charge id from the expanded balance transaction, fee null while it is pending', () => {
    expect(settlementOf(expanded() as unknown as Stripe.PaymentIntent)).toEqual({
      amountReceived: { amount: 98910, currency: 'usd' },
      fee: { amount: 2898, currency: 'usd' },
      net: { amount: 96012, currency: 'usd' },
      transactionId: 'ch_1',
    })
    // Stripe settles in the account's currency: a CAD charge on a USD account.
    expect(settlementOf(expanded({ currency: 'cad' }, { fee: 2100, net: 70000, currency: 'USD' }) as unknown as Stripe.PaymentIntent)).toMatchObject({
      amountReceived: { amount: 98910, currency: 'cad' },
      fee: { amount: 2100, currency: 'usd' },
    })
    expect(settlementOf(expanded({}, null) as unknown as Stripe.PaymentIntent)).toEqual({
      amountReceived: { amount: 98910, currency: 'usd' },
      fee: null,
      net: null,
      transactionId: 'ch_1',
    })
    expect(settlementOf(expanded({ status: 'processing' }) as unknown as Stripe.PaymentIntent)).toBeNull()
  })

  it('stripe: the webhook records the fee with the payment, and an unreadable intent never loses the payment', async () => {
    const { store, order, ctx } = await discountedOrder()
    let fail = false
    const retrieve = vi.fn(async () => {
      if (fail) throw new Error('rate limited')
      return expanded({ metadata: { order_id: order.id } })
    })
    const session = { id: 'cs_1', client_reference_id: order.id, payment_status: 'paid', currency: 'usd', amount_total: 98910, payment_intent: 'pi_1', payment_method_types: ['card'], total_details: {} }
    const stripe = {
      paymentIntents: { retrieve },
      webhooks: { constructEventAsync: vi.fn(async () => ({ type: 'checkout.session.completed', data: { object: session } })) },
    } as unknown as Stripe
    const adapter = stripePayments({ stripe, webhookSecret: 'whsec' })
    const req = () => new Request('https://store.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 's' }, body: '{}' })

    fail = true
    const bare = await adapter.handleWebhook(req(), ctx)
    expect(bare).toMatchObject([{ type: 'paid', reference: 'pi_1' }])
    expect(bare[0]).not.toHaveProperty('settlement')
    const [paid] = await applyPaymentEvents(store, bare)
    expect(paid!.payment).toMatchObject({ status: 'paid', fee: null, feeReportedAt: null })

    // Redelivery after Stripe answers: the already-paid order gains its fee, nothing else changes.
    fail = false
    const events = await adapter.handleWebhook(req(), ctx)
    expect(retrieve).toHaveBeenLastCalledWith('pi_1', { expand: ['latest_charge.balance_transaction'] })
    const [filled] = await applyPaymentEvents(store, events)
    expect(filled!.payment).toMatchObject({
      status: 'paid',
      amountReceived: { amount: 98910, currency: 'usd' },
      fee: { amount: 2898, currency: 'usd' },
      net: { amount: 96012, currency: 'usd' },
      transactionId: 'ch_1',
      feeReportedAt: expect.any(String),
    })
    expect(filled!.updatedAt > paid!.updatedAt).toBe(true)
    expect(filled!.total).toEqual(paid!.total)
    // Same report again: no write, updated_at stays.
    const [again] = await applyPaymentEvents(store, events)
    expect(again!.updatedAt).toBe(filled!.updatedAt)
    expect(again!.payment.feeReportedAt).toBe(filled!.payment.feeReportedAt)
  })

  it('stripe: the return page records the fee, and settlement() reads it later for the Store API', async () => {
    const { store, order, ctx } = await discountedOrder()
    let bt: unknown = null
    const retrieve = vi.fn(async () => expanded({ metadata: { order_id: order.id } }, bt))
    const sessions = { retrieve: vi.fn(async () => ({ id: 'cs_1', client_reference_id: order.id, payment_status: 'paid', currency: 'usd', amount_total: 98910, payment_intent: 'pi_1', total_details: {} })) }
    const stripe = { paymentIntents: { retrieve }, checkout: { sessions } } as unknown as Stripe
    const adapter = stripePayments({ stripe, webhookSecret: 'x' })
    const [paid] = await applyPaymentEvents(store, await adapter.verifyReturn!(new URLSearchParams('session_id=cs_1'), order, ctx))
    expect(paid!.payment).toMatchObject({ status: 'paid', reference: 'pi_1', transactionId: 'ch_1', amountReceived: { amount: 98910 }, fee: null })

    bt = { fee: 2898, net: 96012, currency: 'usd' }
    expect(await adapter.settlement!(paid!)).toMatchObject({ fee: { amount: 2898, currency: 'usd' }, transactionId: 'ch_1' })
    expect(await adapter.settlement!({ ...paid!, payment: { ...paid!.payment, reference: 'cs_only' } })).toBeNull()
  })

  const token = { 'POST https://api-m.sandbox.paypal.com/v1/oauth2/token': () => ({ body: { access_token: 'A', expires_in: 3600 } }) }
  const breakdown = {
    gross_amount: { currency_code: 'USD', value: '989.10' },
    paypal_fee: { currency_code: 'USD', value: '34.99' },
    net_amount: { currency_code: 'USD', value: '954.11' },
  }

  it('paypal: records the fee from the capture response at capture time', async () => {
    const { store, order } = await discountedOrder()
    const capture = { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '989.10' }, seller_receivable_breakdown: breakdown }
    const { fetch } = fakeFetch({
      ...token,
      'GET https://api-m.sandbox.paypal.com/v2/checkout/orders/PP1': () => ({ body: { id: 'PP1', status: 'APPROVED', purchase_units: [{ custom_id: order.id }] } }),
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders/PP1/capture': () => ({ body: { id: 'PP1', status: 'COMPLETED', purchase_units: [{ custom_id: order.id, payments: { captures: [capture] } }] } }),
    })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const events = await adapter.verifyReturn!(new URLSearchParams('token=PP1'), order, { store, siteUrl: '' })
    const [paid] = await applyPaymentEvents(store, events)
    expect(paid!.payment).toMatchObject({
      reference: 'CAP1',
      transactionId: 'CAP1',
      amountReceived: { amount: 98910, currency: 'usd' },
      fee: { amount: 3499, currency: 'usd' },
      net: { amount: 95411, currency: 'usd' },
      feeReportedAt: expect.any(String),
    })
  })

  it('paypal: settlement() reads a capture back, fee null while PayPal has not reported it', async () => {
    const { store, order } = await discountedOrder()
    let capture: Record<string, unknown> = { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '989.10' } }
    const { fetch, calls } = fakeFetch({ ...token, 'GET https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1': () => ({ body: capture }) })
    const adapter = paypalPayments({ clientId: 'c', clientSecret: 's', webhookId: 'W', fetch })
    const paid = await store.orders.markPaid(order.id, { provider: 'paypal', reference: 'CAP1' })
    expect(await adapter.settlement!(paid)).toEqual({ amountReceived: { amount: 98910, currency: 'usd' }, fee: null, net: null, transactionId: 'CAP1' })
    capture = { ...capture, seller_receivable_breakdown: breakdown }
    expect(await adapter.settlement!(paid)).toMatchObject({ fee: { amount: 3499, currency: 'usd' }, net: { amount: 95411, currency: 'usd' } })
    expect(calls.filter((c) => c.url.endsWith('/v2/payments/captures/CAP1'))).toHaveLength(2)
  })

  it('manual, btcpay and bitcoin adapters report no fee', async () => {
    const { manualPayments } = await import('../src/payments/manual')
    expect(manualPayments().settlement).toBeUndefined()
    expect(btcpayPayments({ serverUrl: 'https://btcpay.test', storeId: 's', apiKey: 'k', webhookSecret: 'w' }).settlement).toBeUndefined()
  })
})
