import { defineRoutes, type RoutePatterns, type Routes } from './routes'
import type { ShippingOption } from './shipping'
import { validateDiscounts, validateQuantityDiscounts, type DiscountCode, type QuantityDiscount, type ReferralSettings } from './discounts'

export interface StorefrontInput {
  /** Store name, used in titles, emails and the Store API health check. */
  name: string
  /** Canonical public origin, e.g. https://www.example.com (no trailing slash). */
  url: string
  /** ISO 4217, lower case: 'usd'. */
  currency: string
  /** BCP 47 for formatting: 'en-US'. */
  locale?: string
  routes?: Partial<RoutePatterns>
  /** At least one option. Options that name `countries` are only offered to those countries. */
  shipping: ShippingOption[]
  /** ISO 3166-1 alpha-2 codes the store ships to. */
  shipToCountries: string[]
  contact?: {
    phone?: string
    phoneE164?: string
    email?: string
  }
  checkout?: {
    /** Per line. */
    maxQuantity?: number
    allowPromotionCodes?: boolean
    collectPhone?: boolean
  }
  inventory?: {
    /** `available <= lowStockThreshold` shows as low stock. */
    lowStockThreshold?: number
  }
  orders?: {
    /** Prefix for human order numbers: 'VLD-' → VLD-1001. */
    numberPrefix?: string
  }
  /**
   * Discount codes the store prices itself (see discounts.ts). A code with a
   * `partner` attributes the order to that partner and snapshots the
   * commission owed. Prefer these over processor promotion codes: they work
   * under every payment adapter and land on the order.
   */
  discounts?: DiscountCode[]
  /** Percent off by units in the order (see discounts.ts). Never stacks with a code: the larger saving wins. */
  quantityDiscounts?: QuantityDiscount[]
  /** `?code=` links that apply a code for a while. Defaults: param "code", 30 days. */
  referral?: Partial<ReferralSettings>
}

export interface StorefrontConfig extends Omit<StorefrontInput, 'routes' | 'locale' | 'checkout' | 'inventory' | 'orders' | 'discounts' | 'quantityDiscounts' | 'referral'> {
  locale: string
  routes: Routes
  checkout: {
    maxQuantity: number
    allowPromotionCodes: boolean
    collectPhone: boolean
  }
  inventory: {
    lowStockThreshold: number
  }
  orders: {
    numberPrefix: string
  }
  discounts: DiscountCode[]
  quantityDiscounts: QuantityDiscount[]
  referral: ReferralSettings
}

/**
 * Validate and fill in a store's configuration. Every store has exactly one
 * of these, exported from storefront.config.ts.
 */
export function defineStorefront(input: StorefrontInput): StorefrontConfig {
  if (!/^https?:\/\//.test(input.url)) throw new Error(`storefront.url must be absolute, got ${input.url}`)
  if (input.url.endsWith('/')) throw new Error('storefront.url must not end with a slash')
  if (!input.shipping.length) throw new Error('storefront.shipping needs at least one option')
  if (!input.shipToCountries.length) throw new Error('storefront.shipToCountries needs at least one country')
  validateDiscounts(input.discounts ?? [], input.currency)
  validateQuantityDiscounts(input.quantityDiscounts ?? [])
  const referralParam = input.referral?.param ?? 'code'
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(referralParam)) throw new Error(`storefront.referral.param "${referralParam}" must be a short lower-case query parameter`)

  return {
    ...input,
    locale: input.locale ?? 'en-US',
    routes: defineRoutes(input.routes),
    checkout: {
      maxQuantity: input.checkout?.maxQuantity ?? 10,
      allowPromotionCodes: input.checkout?.allowPromotionCodes ?? true,
      collectPhone: input.checkout?.collectPhone ?? true,
    },
    inventory: {
      lowStockThreshold: input.inventory?.lowStockThreshold ?? 3,
    },
    orders: {
      numberPrefix: input.orders?.numberPrefix ?? '',
    },
    discounts: input.discounts ?? [],
    quantityDiscounts: input.quantityDiscounts ?? [],
    referral: {
      param: referralParam,
      cookieDays: input.referral?.cookieDays ?? 30,
    },
  }
}
