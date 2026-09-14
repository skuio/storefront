import { defineRoutes, type RoutePatterns, type Routes } from './routes'
import type { ShippingOption } from './shipping'

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
}

export interface StorefrontConfig extends Omit<StorefrontInput, 'routes' | 'locale' | 'checkout' | 'inventory' | 'orders'> {
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
  }
}
