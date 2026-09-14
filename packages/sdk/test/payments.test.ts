import { describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import { applyPaymentEvents, PaymentWebhookError } from '../src/payments'
import { manualPayments } from '../src/payments/manual'
import { eventsFromStripe, stripePayments } from '../src/payments/stripe'
import { placeOrder, rig, seed } from './helpers'

const SECRET = 'whsec_test_secret'

function fakeStripe() {
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', params }))
  const retrieve = vi.fn()
  const real = new Stripe('sk_test_x', { httpClient: Stripe.createFetchHttpClient() })
  const stripe = { checkout: { sessions: { create, retrieve } }, webhooks: real.webhooks } as unknown as Stripe
  return { stripe, create, retrieve, real }
}

const session = (over: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session =>
  ({
    id: 'cs_test_1',
    object: 'checkout.session',
    client_reference_id: 'ord_1',
    metadata: { order_id: 'ord_1' },
    payment_status: 'paid',
    payment_intent: 'pi_1',
    currency: 'usd',
    amount_total: 109900,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    payment_method_types: ['card'],
    ...over,
  }) as unknown as Stripe.Checkout.Session

describe('stripe adapter', () => {
  it('starts hosted Checkout in payment-only mode from the order', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }], shippingAddress: { name: 'Ada', line1: '1 Way', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } })
    const { stripe, create } = fakeStripe()
    const adapter = stripePayments({ stripe, webhookSecret: SECRET })
    const start = await adapter.start(order, { store, siteUrl: 'https://store.test' })
    expect(start).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    const p = create.mock.calls[0]![0]
    expect(p.mode).toBe('payment')
    expect(p.client_reference_id).toBe(order.id)
    expect(p.customer_email).toBe('ada@example.com')
    expect(p.metadata).toMatchObject({ order_id: order.id, order_number: '1001' })
    expect(p.line_items).toEqual([{ quantity: 2, price_data: { currency: 'usd', unit_amount: 109900, product_data: { name: order.lines[0]!.name, metadata: { sku: 'VDCTOYTAC9504' } } } }])
    expect(p.shipping_options).toEqual([{ shipping_rate_data: { type: 'fixed_amount', display_name: 'Free shipping (United States)', fixed_amount: { amount: 0, currency: 'usd' }, metadata: { shipping_option_id: 'us' } } }])
    expect(p.shipping_address_collection).toBeUndefined()
    expect(p.payment_intent_data?.shipping?.address).toEqual({ line1: '1 Way', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' })
    expect(p.success_url).toBe(`https://store.test/checkout/success/?order=${order.id}&key=${order.accessKey}&session_id={CHECKOUT_SESSION_ID}`)
    expect(p.cancel_url).toBe(`https://store.test/cart/?checkout_error=cancelled&order=${order.id}`)
    expect((await store.events.list(order.id)).map((e) => e.type)).toEqual(['created', 'checkout_session_created'])
  })

  it('verifies webhook signatures and maps events', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const { stripe, real } = fakeStripe()
    const adapter = stripePayments({ stripe, webhookSecret: SECRET })
    const ctx = { store, siteUrl: 'https://store.test' }
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: session({ client_reference_id: order.id, metadata: { order_id: order.id } }) } })
    const signature = real.webhooks.generateTestHeaderString({ payload, secret: SECRET })

    await expect(adapter.handleWebhook(new Request('https://store.test/api/payments/webhook', { method: 'POST', body: payload }), ctx)).rejects.toBeInstanceOf(PaymentWebhookError)
    await expect(adapter.handleWebhook(new Request('https://store.test/api/payments/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': 'v1=bad,t=1' } }), ctx)).rejects.toMatchObject({ status: 400 })

    const events = await adapter.handleWebhook(new Request('https://store.test/api/payments/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': signature } }), ctx)
    expect(events).toEqual([expect.objectContaining({ type: 'paid', orderId: order.id, provider: 'stripe', reference: 'pi_1', methodLabel: 'Card', amount: { amount: 109900, currency: 'usd' } })])

    const [paid] = await applyPaymentEvents(store, events)
    expect(paid!.status).toBe('paid')
    expect(paid!.payment.reference).toBe('pi_1')
    // Redelivery is harmless.
    await applyPaymentEvents(store, events)
    expect((await store.orders.require(order.id)).updatedAt).toBe(paid!.updatedAt)

    const unconfigured = stripePayments({ stripe, webhookSecret: undefined })
    await expect(unconfigured.handleWebhook(new Request('https://x', { method: 'POST', body: payload }), ctx)).rejects.toMatchObject({ status: 500 })
  })

  it('maps the other Stripe events', () => {
    const ev = (type: string, object: unknown) => ({ type, data: { object } }) as unknown as Stripe.Event
    expect(eventsFromStripe(ev('checkout.session.completed', session({ payment_status: 'unpaid' })))).toEqual([{ type: 'ignored', reason: expect.stringContaining('unpaid') }])
    expect(eventsFromStripe(ev('checkout.session.async_payment_succeeded', session({ total_details: { amount_discount: 5000, amount_shipping: 0, amount_tax: 0 }, amount_total: 104900 })))).toEqual([
      expect.objectContaining({ type: 'paid', adjustments: { discount: { amount: 5000, currency: 'usd' }, tax: { amount: 0, currency: 'usd' }, total: { amount: 104900, currency: 'usd' } } }),
    ])
    expect(eventsFromStripe(ev('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })))).toEqual([{ type: 'failed', orderId: 'ord_1', provider: 'stripe', reference: 'pi_1', reason: 'async payment failed' }])
    expect(eventsFromStripe(ev('charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_1', metadata: { order_id: 'ord_1' } }))).toEqual([{ type: 'refunded', orderId: 'ord_1', provider: 'stripe', reference: 'pi_1' }])
    expect(eventsFromStripe(ev('charge.refunded', { id: 'ch_1', refunded: false, payment_intent: 'pi_1', metadata: {} }))).toEqual([{ type: 'ignored', reason: expect.stringContaining('partially') }])
    expect(eventsFromStripe(ev('payment_intent.created', {}))).toEqual([{ type: 'ignored', reason: 'unhandled event payment_intent.created' }])
    expect(eventsFromStripe(ev('checkout.session.completed', session({ client_reference_id: null, metadata: {} })))).toEqual([{ type: 'ignored', reason: expect.stringContaining('no order id') }])
  })

  it('confirms a paid session on return before the webhook lands', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const { stripe, retrieve } = fakeStripe()
    retrieve.mockResolvedValue(session({ client_reference_id: order.id, metadata: { order_id: order.id } }))
    const adapter = stripePayments({ stripe, webhookSecret: SECRET })
    const ctx = { store, siteUrl: 'https://store.test' }
    expect(await adapter.verifyReturn!(new URLSearchParams(''), order, ctx)).toEqual([])
    const events = await adapter.verifyReturn!(new URLSearchParams('session_id=cs_test_1'), order, ctx)
    expect(events[0]).toMatchObject({ type: 'paid', orderId: order.id })
    retrieve.mockResolvedValue(session({ client_reference_id: 'ord_other' }))
    expect(await adapter.verifyReturn!(new URLSearchParams('session_id=cs_test_1'), order, ctx)).toEqual([])
  })

  it('refunds by payment reference when the charge carries no order id', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    await store.orders.markPaid(order.id, { provider: 'stripe', reference: 'pi_9' })
    const [refunded] = await applyPaymentEvents(store, [{ type: 'refunded', orderId: null, provider: 'stripe', reference: 'pi_9' }])
    expect(refunded!.status).toBe('refunded')
    expect(await applyPaymentEvents(store, [{ type: 'refunded', orderId: null, provider: 'stripe', reference: 'pi_unknown' }])).toEqual([])
  })
})

describe('manual adapter', () => {
  it('shows instructions and leaves the order pending until the Store API marks it paid', async () => {
    const { store, mail } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const adapter = manualPayments()
    const start = await adapter.start(order, { store, siteUrl: 'https://store.test' })
    expect(start.kind).toBe('instructions')
    expect(start.kind === 'instructions' && start.html).toContain('1001')
    expect(start.kind === 'instructions' && start.html).toContain('$1,099')
    expect(mail.sent).toEqual([]) // the checkout endpoint sends the receipt, start() stays pure
    expect((await store.orders.require(order.id)).status).toBe('pending_payment')
    expect(await adapter.handleWebhook(new Request('https://x', { method: 'POST' }), { store, siteUrl: 'https://store.test' })).toEqual([{ type: 'ignored', reason: expect.any(String) }])
    const custom = manualPayments({ label: 'Bank transfer', instructions: (o) => `<p>Wire ${o.total.amount}</p>` })
    expect(custom.label).toBe('Bank transfer')
    expect(await custom.start(order, { store, siteUrl: 'https://store.test' })).toEqual({ kind: 'instructions', html: '<p>Wire 109900</p>' })
  })
})
