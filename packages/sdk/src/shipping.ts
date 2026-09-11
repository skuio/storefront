import type { Money } from './types.js'

export interface ShippingOption {
  id: string
  label: string
  price: Money
  /** Business days, inclusive range. */
  estimate?: { min: number; max: number }
}

export function freeShipping(id: string, label: string, estimate?: ShippingOption['estimate']): ShippingOption {
  return { id, label, price: { amount: 0, currency: 'usd' }, estimate }
}

export function flatRate(
  id: string,
  label: string,
  price: Money,
  estimate?: ShippingOption['estimate']
): ShippingOption {
  return { id, label, price, estimate }
}
