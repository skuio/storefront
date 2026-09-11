import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { flatRate, freeShipping, hasInternationalRegion, shippingForRegion } from '../src/shipping.js'
import { Catalog } from '../src/catalog.js'
import { defineStorefront } from '../src/config.js'
import { jsonProvider } from '../src/providers/json.js'
import { createStripeCheckout } from '../src/checkout/stripe.js'
import { categories, products } from './fixtures.js'

const us = freeShipping('us', 'Free (US)', { countries: ['US'] })
const intl = flatRate('intl', 'International', { amount: 40000, currency: 'usd' })
const ship = ['US', 'CA', 'GB', 'AU']

describe('shippingForRegion', () => {
  it('is a no-op when no option names countries', () => {
    const plain = [freeShipping('a', 'A'), flatRate('b', 'B', { amount: 1, currency: 'usd' })]
    const r = shippingForRegion(plain, ship, 'international')
    expect(r).toEqual({ options: plain, countries: ship, enforced: false })
    expect(hasInternationalRegion(plain, ship)).toBe(false)
  })

  it('splits domestic and international by the countries an option names', () => {
    expect(shippingForRegion([us, intl], ship, 'domestic')).toEqual({ options: [us], countries: ['US'], enforced: true })
    expect(shippingForRegion([us, intl], ship, 'international')).toEqual({ options: [intl], countries: ['CA', 'GB', 'AU'], enforced: true })
    expect(hasInternationalRegion([us, intl], ship)).toBe(true)
  })

  it('has no international region when every ship-to country is domestic', () => {
    expect(hasInternationalRegion([us, intl], ['US'])).toBe(false)
  })
})

describe('createStripeCheckout with regions', () => {
  const catalog = Catalog.fromData(products, categories)
  const input = {
    name: 'T', url: 'https://t.example', currency: 'usd',
    provider: jsonProvider({ products, categories }),
    shipping: [us, intl], shipToCountries: ship,
  }
  const config = defineStorefront(input)
  const fake = () => {
    const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({ id: 'cs_test_x', url: 'https://checkout.stripe.com/x', params }))
    return { stripe: { checkout: { sessions: { create } } } as unknown as Stripe, create }
  }
  const base = { catalog, config, items: [{ sku: 'VDCTOYTAC9504', quantity: 1 }], successUrl: 'https://t/ok', cancelUrl: 'https://t/no' }

  it('opens a domestic session with only domestic rates and countries by default', async () => {
    const { stripe, create } = fake()
    await createStripeCheckout({ ...base, stripe })
    const p = create.mock.calls[0]![0]
    expect(p.shipping_address_collection!.allowed_countries).toEqual(['US'])
    expect(p.shipping_options!.map((o) => o.shipping_rate_data!.display_name)).toEqual(['Free (US)'])
    expect(p.metadata).toMatchObject({ region: 'domestic' })
  })

  it('opens an international session that cannot take a domestic address or rate', async () => {
    const { stripe, create } = fake()
    await createStripeCheckout({ ...base, stripe, region: 'international' })
    const p = create.mock.calls[0]![0]
    expect(p.shipping_address_collection!.allowed_countries).toEqual(['CA', 'GB', 'AU'])
    expect(p.shipping_options!.map((o) => o.shipping_rate_data!.display_name)).toEqual(['International'])
  })

  it('refuses a region with nothing to offer', async () => {
    const { stripe } = fake()
    const usOnly = defineStorefront({ ...input, shipping: [us], shipToCountries: ['US'] })
    await expect(createStripeCheckout({ ...base, stripe, config: usOnly, region: 'international' })).rejects.toMatchObject({ code: 'no_shipping' })
  })
})
