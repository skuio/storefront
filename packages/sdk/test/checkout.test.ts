import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { Catalog } from '../src/catalog.js'
import { defineStorefront } from '../src/config.js'
import { jsonProvider } from '../src/providers/json.js'
import { freeShipping, flatRate } from '../src/shipping.js'
import { createStripeCheckout, CheckoutError } from '../src/checkout/stripe.js'
import { categories, products } from './fixtures.js'

const catalog = Catalog.fromData(products, categories)
const config = defineStorefront({
  name: 'Test Store',
  url: 'https://example.com',
  currency: 'usd',
  provider: jsonProvider({ products, categories }),
  shipping: [
    freeShipping('us', 'Free shipping (US)', { min: 3, max: 10 }),
    flatRate('intl', 'International', { amount: 40000, currency: 'usd' }),
  ],
  shipToCountries: ['US', 'CA'],
  checkout: { maxQuantity: 5 },
})

function fakeStripe() {
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({
    id: 'cs_test_abc',
    url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
    params,
  }))
  return { stripe: { checkout: { sessions: { create } } } as unknown as Stripe, create }
}

describe('createStripeCheckout', () => {
  it('prices from the catalogue, never from the caller', async () => {
    const { stripe, create } = fakeStripe()
    const result = await createStripeCheckout({
      stripe,
      catalog,
      config,
      items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }],
      successUrl: 'https://example.com/ok?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://example.com/cancel',
    })
    expect(result.url).toContain('checkout.stripe.com')

    const params = create.mock.calls[0]![0]
    const line = params.line_items![0]!
    expect(line.price_data!.unit_amount).toBe(109900)
    expect(line.quantity).toBe(2)
    expect(line.price_data!.product_data!.metadata).toMatchObject({ sku: 'VDCTOYTAC9504' })
    expect(params.shipping_options).toHaveLength(2)
    expect(params.shipping_address_collection!.allowed_countries).toEqual(['US', 'CA'])
    expect(params.metadata).toMatchObject({ skus: 'VDCTOYTAC9504', storefront: 'Test Store' })
  })

  it('clamps quantity to [1, maxQuantity]', async () => {
    const { stripe, create } = fakeStripe()
    await createStripeCheckout({
      stripe, catalog, config,
      items: [{ sku: 'VDCTOYTAC9504', quantity: 999 }, { sku: 'VDCTOYSUP9302', quantity: -4 }],
      successUrl: 'https://x/ok', cancelUrl: 'https://x/no',
    })
    const lines = create.mock.calls[0]![0].line_items!
    expect(lines[0]!.quantity).toBe(5)
    expect(lines[1]!.quantity).toBe(1)
  })

  it('refuses unknown and unavailable skus before touching Stripe', async () => {
    const { stripe, create } = fakeStripe()
    const base = { stripe, catalog, config, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' }
    await expect(createStripeCheckout({ ...base, items: [{ sku: 'NOPE', quantity: 1 }] }))
      .rejects.toMatchObject({ code: 'unknown_sku' })
    await expect(createStripeCheckout({ ...base, items: [{ sku: 'VDCHCIV0611', quantity: 1 }] }))
      .rejects.toBeInstanceOf(CheckoutError)
    expect(create).not.toHaveBeenCalled()
  })
})
