import type { Money } from './types.js'

export interface ShippingOption {
  id: string
  label: string
  price: Money
  /** Business days, inclusive range. */
  estimate?: { min: number; max: number }
  /**
   * Destinations this rate applies to (ISO 3166-1 alpha-2). Omit for "every
   * country not claimed by another option". Naming countries on at least one
   * option turns on region enforcement: a checkout is opened for one region at
   * a time, with only that region's rates and addresses. That is how a store
   * stops an international customer choosing the free domestic rate — Stripe
   * Checkout cannot filter rates by country on its own.
   */
  countries?: string[]
}

export interface ShippingOptionExtras {
  estimate?: ShippingOption['estimate']
  countries?: string[]
}

export function freeShipping(id: string, label: string, extras: ShippingOptionExtras = {}): ShippingOption {
  return { id, label, price: { amount: 0, currency: 'usd' }, ...extras }
}

export function flatRate(id: string, label: string, price: Money, extras: ShippingOptionExtras = {}): ShippingOption {
  return { id, label, price, ...extras }
}

export type ShippingRegion = 'domestic' | 'international'

export interface ResolvedShipping {
  options: ShippingOption[]
  countries: string[]
  /** False when no option names countries: one region, every rate, every country. */
  enforced: boolean
}

/**
 * The rates and destinations a checkout may offer for a region.
 *
 * domestic      = options that name countries, shipped to those countries
 * international = options that name none, shipped to every remaining ship-to country
 */
export function shippingForRegion(
  shipping: ShippingOption[],
  shipToCountries: string[],
  region: ShippingRegion
): ResolvedShipping {
  const scoped = shipping.filter((o) => o.countries && o.countries.length > 0)
  if (scoped.length === 0) return { options: shipping, countries: shipToCountries, enforced: false }

  const domestic = [...new Set(scoped.flatMap((o) => o.countries!))].filter((c) => shipToCountries.includes(c))
  if (region === 'domestic') return { options: scoped, countries: domestic, enforced: true }

  const rest = shipping.filter((o) => !o.countries || o.countries.length === 0)
  const international = shipToCountries.filter((c) => !domestic.includes(c))
  return { options: rest, countries: international, enforced: true }
}

/** Whether a store has anything to offer outside its domestic region. */
export function hasInternationalRegion(shipping: ShippingOption[], shipToCountries: string[]): boolean {
  const r = shippingForRegion(shipping, shipToCountries, 'international')
  return r.enforced && r.options.length > 0 && r.countries.length > 0
}
