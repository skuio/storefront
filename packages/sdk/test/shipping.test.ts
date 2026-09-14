import { describe, expect, it } from 'vitest'
import { flatRate, freeShipping, hasInternationalRegion, regionForCountry, shippingForCountry, shippingForRegion } from '../src/shipping.js'

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

describe('regionForCountry / shippingForCountry', () => {
  it('routes a destination to its region and rates', () => {
    expect(regionForCountry([us, intl], ship, 'US')).toBe('domestic')
    expect(regionForCountry([us, intl], ship, 'gb')).toBe('international')
    expect(regionForCountry([us, intl], ship, 'FR')).toBeNull()
    expect(shippingForCountry([us, intl], ship, 'CA')).toEqual([intl])
    expect(shippingForCountry([us, intl], ship, 'US')).toEqual([us])
    expect(shippingForCountry([us, intl], ship, 'FR')).toEqual([])
  })

  it('treats every ship-to country as domestic when no option names countries', () => {
    const plain = [freeShipping('a', 'A')]
    expect(regionForCountry(plain, ship, 'GB')).toBe('domestic')
    expect(shippingForCountry(plain, ship, 'GB')).toEqual(plain)
  })
})
