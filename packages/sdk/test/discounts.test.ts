import { describe, expect, it } from 'vitest'
import { defineStorefront, discountAmount, findDiscount, flatRate, freeShipping, type DiscountCode } from '../src'
import { config, placeOrder, rig, seed } from './helpers'

const codes: DiscountCode[] = [
  { code: 'Podcast', percentOff: 10, partner: 'orbit-show', commissionPercent: 15 },
  { code: 'TENOFF', amountOff: 1000 },
  { code: 'LATER', percentOff: 50, startsAt: '2027-01-01T00:00:00Z' },
  { code: 'OFF', percentOff: 50, active: false },
]

const withCodes = defineStorefront({
  name: 'Test Store',
  url: 'https://store.test',
  currency: 'usd',
  shipping: [
    freeShipping('us', 'Free shipping (United States)', { countries: ['US'] }),
    flatRate('intl', 'International shipping', { amount: 4000, currency: 'usd' }),
  ],
  shipToCountries: ['US', 'CA', 'GB'],
  discounts: codes,
  quantityDiscounts: [{ minQuantity: 2, percentOff: 5 }, { minQuantity: 3, percentOff: 20 }],
})

describe('discount codes', () => {
  it('validates configuration', () => {
    const base = { name: 'X', url: 'https://x.test', currency: 'usd', shipping: config.shipping, shipToCountries: ['US'] }
    expect(() => defineStorefront({ ...base, discounts: [{ code: 'A B!' , percentOff: 5 }] })).toThrow(/letters/)
    expect(() => defineStorefront({ ...base, discounts: [{ code: 'DUP', percentOff: 5 }, { code: 'dup', amountOff: 100 }] })).toThrow(/twice/)
    expect(() => defineStorefront({ ...base, discounts: [{ code: 'BOTH', percentOff: 5, amountOff: 100 }] })).toThrow(/exactly one/)
    expect(() => defineStorefront({ ...base, discounts: [{ code: 'CUT', percentOff: 5, commissionPercent: 10 }] })).toThrow(/partner/)
    expect(() => defineStorefront({ ...base, referral: { param: 'Bad Param' } })).toThrow(/query parameter/)
    expect(defineStorefront(base).referral).toEqual({ param: 'code', cookieDays: 30 })
  })

  it('matches case- and space-insensitively and honours the window and the switch', () => {
    const now = new Date('2026-10-16T00:00:00Z')
    expect(findDiscount(codes, ' pod cast ', now)?.code).toBe('Podcast')
    expect(findDiscount(codes, 'LATER', now)).toBeNull()
    expect(findDiscount(codes, 'LATER', new Date('2027-02-01T00:00:00Z'))?.code).toBe('LATER')
    expect(findDiscount(codes, 'OFF', now)).toBeNull()
    expect(findDiscount(codes, 'NOPE', now)).toBeNull()
    expect(discountAmount({ code: 'X', percentOff: 10 }, 14999)).toBe(1500)
    expect(discountAmount({ code: 'X', amountOff: 99999 }, 14999)).toBe(14999)
  })

  it('prices the code into the order, snapshots the partner commission and reports it', async () => {
    const { store, clock } = rig({ SESSION_SECRET: 'test-secret' }, withCodes)
    await seed(store)
    const order = await placeOrder(store, { discountCode: 'podcast' })
    expect(order.subtotal.amount).toBe(109900)
    expect(order.discount.amount).toBe(10990)
    expect(order.total.amount).toBe(98910)
    expect(order.discountCode).toBe('PODCAST')
    expect(order.partner).toEqual({ id: 'orbit-show', commission: { amount: 14837, currency: 'usd' } })

    // Unpaid orders are not the partner's business.
    expect((await store.partners.report('orbit-show')).lines).toEqual([])

    await store.orders.markPaid(order.id, { provider: 'manual', reference: null })
    const held = await store.partners.report('orbit-show')
    expect(held.lines).toHaveLength(1)
    expect(held.lines[0]).toMatchObject({ number: order.number, country: 'US', units: 1, state: 'held', merchandise: { amount: 98910 }, commission: { amount: 14837 } })
    expect(held.totals).toMatchObject({ orders: 1, payable: { amount: 0 }, held: { amount: 14837 } })
    expect(JSON.stringify(held)).not.toContain('ada@example.com')

    clock.tick(31 * 86_400_000)
    expect((await store.partners.report('orbit-show')).totals.payable.amount).toBe(14837)

    // A code without a partner discounts but attributes nothing.
    const plain = await placeOrder(store, { discountCode: 'TENOFF' })
    expect([plain.discount.amount, plain.partner]).toEqual([1000, null])
  })

  it('refuses a code that is not valid rather than dropping it', async () => {
    const { store } = rig({}, withCodes)
    await seed(store)
    await expect(placeOrder(store, { discountCode: 'OFF' })).rejects.toMatchObject({ details: { discount_code: 'is not a valid code' } })
    const none = await placeOrder(store, { discountCode: '  ' })
    expect(none.discount.amount).toBe(0)
  })

  it('signs partner report links with SESSION_SECRET', async () => {
    const { store } = rig({ SESSION_SECRET: 'test-secret' }, withCodes)
    const key = await store.partners.reportKey('orbit-show')
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(await store.partners.verifyReportKey('orbit-show', key)).toBe(true)
    expect(await store.partners.verifyReportKey('orbit-show', key.replace(/.$/, '0') === key ? key.replace(/.$/, '1') : key.replace(/.$/, '0'))).toBe(false)
    expect(await store.partners.verifyReportKey('someone-else', key)).toBe(false)
    expect(store.partners.lookupCode('podcast')).toEqual({ code: 'PODCAST', label: '10% off', percentOff: 10, amountOff: null })
  })

  it('prices quantity tiers, never stacked with a code, and keeps the partner on the order', async () => {
    const { store } = rig({}, withCodes)
    await seed(store)
    const one = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 1 }] })
    expect(one.discount.amount).toBe(0)
    const two = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }] })
    expect(two.discount.amount).toBe(Math.round(219800 * 0.05))
    // 2 units: the 10% code beats the 5% tier.
    const twoCode = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }], discountCode: 'PODCAST' })
    expect(twoCode.discount.amount).toBe(21980)
    // 3 units: the 20% tier beats the code, but the partner still gets the order — on what was charged.
    const three = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 3 }], discountCode: 'PODCAST' })
    expect(three.discount.amount).toBe(65940)
    expect(three.discountCode).toBe('PODCAST')
    expect(three.partner?.commission.amount).toBe(Math.round((329700 - 65940) * 0.15))
  })

  it('validates quantity tiers', () => {
    const base = { name: 'X', url: 'https://x.test', currency: 'usd', shipping: config.shipping, shipToCountries: ['US'] }
    expect(() => defineStorefront({ ...base, quantityDiscounts: [{ minQuantity: 1, percentOff: 5 }] })).toThrow(/>= 2/)
    expect(() => defineStorefront({ ...base, quantityDiscounts: [{ minQuantity: 2, percentOff: 0 }] })).toThrow(/percentOff/)
  })
})
