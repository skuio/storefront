import type { CatalogProvider } from './provider.js'
import { defineRoutes, type RoutePatterns, type Routes } from './routes.js'
import type { ShippingOption } from './shipping.js'

export interface StorefrontConfigInput {
  /** Display name, used in titles and schema.org markup. */
  name: string
  /** Canonical origin, e.g. https://www.example.com — no trailing slash. */
  url: string
  currency: string
  locale?: string
  provider: CatalogProvider
  routes?: Partial<RoutePatterns>
  shipping: ShippingOption[]
  /** ISO 3166-1 alpha-2 codes checkout will ship to. */
  shipToCountries: string[]
  contact?: { phone?: string; phoneE164?: string; email?: string }
  checkout?: {
    /** Upper bound on quantity per line. Default 10. */
    maxQuantity?: number
    allowPromotionCodes?: boolean
    collectPhone?: boolean
  }
}

export interface StorefrontConfig extends Omit<StorefrontConfigInput, 'routes' | 'locale' | 'checkout'> {
  locale: string
  routes: Routes
  checkout: Required<NonNullable<StorefrontConfigInput['checkout']>>
}

/** Validates and fills defaults. Throws early on the mistakes that are painful late. */
export function defineStorefront(input: StorefrontConfigInput): StorefrontConfig {
  if (input.url.endsWith('/')) {
    throw new Error(`storefront.url must not end with '/': ${input.url}`)
  }
  if (!/^https?:\/\//.test(input.url)) {
    throw new Error(`storefront.url must be an absolute origin: ${input.url}`)
  }
  if (input.shipping.length === 0) {
    throw new Error('storefront.shipping needs at least one option')
  }

  return {
    ...input,
    locale: input.locale ?? 'en-US',
    routes: defineRoutes(input.routes),
    checkout: {
      maxQuantity: input.checkout?.maxQuantity ?? 10,
      allowPromotionCodes: input.checkout?.allowPromotionCodes ?? true,
      collectPhone: input.checkout?.collectPhone ?? true,
    },
  }
}
