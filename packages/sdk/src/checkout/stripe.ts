import type Stripe from 'stripe'
import type { Catalog } from '../catalog.js'
import type { StorefrontConfig } from '../config.js'
import { shippingForRegion, type ShippingRegion } from '../shipping.js'

export interface CheckoutItem {
  sku: string
  quantity: number
}

export interface CreateStripeCheckoutOptions {
  stripe: Stripe
  catalog: Catalog
  config: StorefrontConfig
  items: CheckoutItem[]
  /** Absolute. Should include {CHECKOUT_SESSION_ID} so the success page can load the order. */
  successUrl: string
  cancelUrl: string
  metadata?: Record<string, string>
  /** Which shipping region to open the session for. Default domestic. */
  region?: ShippingRegion
}

export interface CheckoutResult {
  id: string
  url: string
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_sku' | 'unavailable' | 'empty' | 'no_url' | 'no_shipping'
  ) {
    super(message)
    this.name = 'CheckoutError'
  }
}

/**
 * Create a Stripe Checkout Session from SKUs and quantities.
 *
 * The caller passes SKUs, never prices: every unit_amount comes from the
 * catalogue on the server, so nothing a browser can edit reaches Stripe.
 * Quantities are clamped to [1, config.checkout.maxQuantity].
 */
export async function createStripeCheckout(opts: CreateStripeCheckoutOptions): Promise<CheckoutResult> {
  const { stripe, catalog, config } = opts
  const maxQty = config.checkout.maxQuantity

  if (opts.items.length === 0) throw new CheckoutError('No items', 'empty')

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  const skus: string[] = []

  for (const item of opts.items) {
    const product = catalog.product(item.sku)
    if (!product) throw new CheckoutError(`Unknown SKU ${item.sku}`, 'unknown_sku')
    if (!product.available) throw new CheckoutError(`${item.sku} is unavailable`, 'unavailable')

    const quantity = Number.isFinite(item.quantity)
      ? Math.min(Math.max(Math.trunc(item.quantity), 1), maxQty)
      : 1

    skus.push(product.sku)
    lineItems.push({
      quantity,
      adjustable_quantity: { enabled: true, minimum: 1, maximum: maxQty },
      price_data: {
        currency: product.price.currency.toLowerCase(),
        unit_amount: product.price.amount,
        product_data: {
          name: product.name,
          description: product.shortDescription
            ? stripText(product.shortDescription, 200)
            : `SKU ${product.sku}`,
          metadata: { sku: product.sku, product_id: product.id },
        },
      },
    })
  }

  const resolved = shippingForRegion(config.shipping, config.shipToCountries, opts.region ?? 'domestic')
  if (resolved.options.length === 0 || resolved.countries.length === 0) {
    throw new CheckoutError(`No shipping available for the ${opts.region ?? 'domestic'} region`, 'no_shipping')
  }

  const shippingOptions: Stripe.Checkout.SessionCreateParams.ShippingOption[] = resolved.options.map(
    (s) => ({
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: s.label,
        fixed_amount: { amount: s.price.amount, currency: s.price.currency.toLowerCase() },
        ...(s.estimate
          ? {
              delivery_estimate: {
                minimum: { unit: 'business_day', value: s.estimate.min },
                maximum: { unit: 'business_day', value: s.estimate.max },
              },
            }
          : {}),
        metadata: { shipping_option_id: s.id },
      },
    })
  )

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    shipping_address_collection: {
      allowed_countries:
        resolved.countries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
    },
    shipping_options: shippingOptions,
    phone_number_collection: { enabled: config.checkout.collectPhone },
    allow_promotion_codes: config.checkout.allowPromotionCodes,
    billing_address_collection: 'required',
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: {
      storefront: config.name,
      region: opts.region ?? 'domestic',
      skus: skus.join(','),
      ...opts.metadata,
    },
  })

  if (!session.url) throw new CheckoutError(`Session ${session.id} has no url`, 'no_url')
  return { id: session.id, url: session.url }
}

function stripText(html: string, max: number): string {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
