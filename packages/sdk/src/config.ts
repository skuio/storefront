import { defineRoutes, type RoutePatterns, type Routes } from './routes'
import type { ShippingOption } from './shipping'
import { validateDiscounts, validateQuantityDiscounts, type DiscountCode, type PartnerProfile, type QuantityDiscount, type ReferralSettings } from './discounts'

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
    /** Prefix for human order numbers: 'VLD-' → VLD-1001. Shown on pages, emails and receipts, and sent to SKU.io. */
    numberPrefix?: string
    /**
     * The lowest number a new order may take (default 1001). New orders take the next number above the highest
     * order on file, or this, whichever is larger: set it above numbers an earlier platform used (4200 after
     * WooCommerce's VLD4154) so a new order never repeats an old one.
     */
    numberStart?: number
  }
  /** Request-for-quote (see store/quotes.ts). */
  quotes?: {
    /** Prefix for quote numbers: 'Q' → Q1001 (default 'Q'). */
    numberPrefix?: string
    /** The lowest number a new quote may take (default 1001). */
    numberStart?: number
    /** Per line. Quotes are for volume, so this is far above checkout's limit (default 100000). */
    maxQuantity?: number
    /** How many quote requests one email address may send per hour before it is told to wait (default 5). */
    maxRequestsPerHour?: number
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
  /** Profiles for the partners codes name: welcome banner + portal sign-in. */
  partners?: PartnerProfile[]
  /** `?code=` links that apply a code for a while. Defaults: param "code", 30 days. */
  referral?: Partial<ReferralSettings>
}

export interface StorefrontConfig extends Omit<StorefrontInput, 'routes' | 'locale' | 'checkout' | 'inventory' | 'orders' | 'quotes' | 'discounts' | 'quantityDiscounts' | 'partners' | 'referral'> {
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
    numberStart: number
  }
  quotes: {
    numberPrefix: string
    numberStart: number
    maxQuantity: number
    maxRequestsPerHour: number
  }
  discounts: DiscountCode[]
  quantityDiscounts: QuantityDiscount[]
  partners: PartnerProfile[]
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
  const partnerIds = new Set<string>()
  for (const p of input.partners ?? []) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) throw new Error(`partner id "${p.id}" must be lower-case letters, digits and dashes`)
    if (partnerIds.has(p.id)) throw new Error(`partner ${p.id} is defined twice`)
    if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new Error(`partner ${p.id}: email is not an address`)
    partnerIds.add(p.id)
  }
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
      numberStart: Math.max(1, Math.trunc(input.orders?.numberStart ?? 1001)),
    },
    quotes: {
      numberPrefix: input.quotes?.numberPrefix ?? 'Q',
      numberStart: Math.max(1, Math.trunc(input.quotes?.numberStart ?? 1001)),
      maxQuantity: Math.max(1, Math.trunc(input.quotes?.maxQuantity ?? 100_000)),
      maxRequestsPerHour: Math.max(1, Math.trunc(input.quotes?.maxRequestsPerHour ?? 5)),
    },
    discounts: input.discounts ?? [],
    quantityDiscounts: input.quantityDiscounts ?? [],
    partners: input.partners ?? [],
    referral: {
      param: referralParam,
      cookieDays: input.referral?.cookieDays ?? 30,
    },
  }
}
