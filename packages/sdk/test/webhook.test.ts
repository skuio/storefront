import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { parseStripeWebhook, referenceFromSessionId, WebhookSignatureError } from '../src/webhook/stripe.js'

const session = {
  id: 'cs_test_b1arO8YdV9zjHvkhMVAUeXq2OwEW',
  created: 1789200000,
  currency: 'usd',
  amount_subtotal: 109900,
  amount_total: 109900,
  shipping_cost: { amount_total: 0 },
  payment_intent: 'pi_123',
  customer_details: { name: 'QA Buyer', email: 'qa@example.com', phone: '+17025550147' },
  collected_information: {
    shipping_details: {
      name: 'QA Buyer',
      address: { line1: '6185 Beesley Dr', city: 'Las Vegas', state: 'NV', postal_code: '89115', country: 'US' },
    },
  },
  metadata: { skus: 'VDCTOYTAC9504' },
  line_items: {
    data: [
      {
        description: 'Toyota Tacoma 1995-2004',
        quantity: 1,
        amount_total: 109900,
        price: { unit_amount: 109900, product: { metadata: { sku: 'VDCTOYTAC9504' } } },
      },
    ],
  },
} as unknown as Stripe.Checkout.Session

function fakeStripe(eventType: string, verifyOk = true) {
  return {
    webhooks: {
      constructEventAsync: vi.fn(async () => {
        if (!verifyOk) throw new Error('bad sig')
        return { type: eventType, data: { object: { id: session.id } } }
      }),
    },
    checkout: { sessions: { retrieve: vi.fn(async () => session) } },
  } as unknown as Stripe
}

describe('parseStripeWebhook', () => {
  it('turns checkout.session.completed into a processor-neutral order', async () => {
    const ev = await parseStripeWebhook({
      stripe: fakeStripe('checkout.session.completed'),
      payload: '{}', signature: 'sig', secret: 'whsec',
    })
    expect(ev.type).toBe('order.completed')
    if (ev.type !== 'order.completed') return
    expect(ev.order.reference).toBe('B1ARO8YDV9ZJ')
    expect(ev.order.total).toEqual({ amount: 109900, currency: 'USD' })
    expect(ev.order.lines[0]).toMatchObject({ sku: 'VDCTOYTAC9504', quantity: 1 })
    expect(ev.order.shippingAddress?.state).toBe('NV')
    expect(ev.order.customer.email).toBe('qa@example.com')
    expect(ev.order.processorPaymentId).toBe('pi_123')
  })

  it('acknowledges other events as ignored', async () => {
    const ev = await parseStripeWebhook({
      stripe: fakeStripe('payment_intent.created'),
      payload: '{}', signature: 'sig', secret: 'whsec',
    })
    expect(ev.type).toBe('ignored')
  })

  it('surfaces a bad signature as its own error type', async () => {
    await expect(parseStripeWebhook({
      stripe: fakeStripe('checkout.session.completed', false),
      payload: '{}', signature: 'sig', secret: 'whsec',
    })).rejects.toBeInstanceOf(WebhookSignatureError)
  })

  it('derives a short stable reference', () => {
    expect(referenceFromSessionId('cs_live_abcdefghijklmnop')).toBe('ABCDEFGHIJKL')
  })
})
