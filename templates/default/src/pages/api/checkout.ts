import type { APIContext } from 'astro'
import { shippingForRegion, type ShippingRegion } from '@skuio/storefront'
import { createStripeCheckout, CheckoutError } from '@skuio/storefront/stripe'
import { catalog, config, routes } from '../../lib/catalog'
import { getStripe, readEnv } from '../../lib/stripe'

export const prerender = false

/** Bounce the customer back where they came from with a message they can act on. */
function fail(context: APIContext, returnTo: string, reason: 'unavailable' | 'error') {
  const url = new URL(returnTo, context.url.origin)
  url.searchParams.set('checkout_error', reason)
  return context.redirect(url.pathname + url.search, 303)
}

/**
 * Two ways in, one shape out:
 *   - Buy Now posts `sku` + `quantity` (one line, bounce back to the product)
 *   - the cart posts `items` = JSON [{ sku, quantity }] (many lines, bounce back to /cart/)
 * Either way only SKUs and quantities are read; prices come from the catalogue.
 */
function readItems(form: FormData): { items: { sku: string; quantity: number }[]; returnTo: string } | null {
  const raw = form.get('items')
  if (typeof raw === 'string' && raw.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const items = parsed
      .map((x) => ({ sku: String((x as { sku?: unknown })?.sku ?? '').trim(), quantity: Number((x as { quantity?: unknown })?.quantity ?? 1) }))
      .filter((x) => x.sku)
    return items.length ? { items, returnTo: '/cart/' } : null
  }
  const sku = String(form.get('sku') ?? '').trim()
  if (!sku) return null
  const product = catalog.product(sku)
  return { items: [{ sku, quantity: Number(form.get('quantity') ?? 1) }], returnTo: product ? routes.product(product, catalog) : '/cart/' }
}

export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const read = readItems(form)
  if (!read) return new Response('Nothing to check out', { status: 400 })
  const { items, returnTo } = read
  const region: ShippingRegion = form.get('region') === 'international' ? 'international' : 'domestic'
  const shipping = shippingForRegion(config.shipping, config.shipToCountries, region)

  // Every SKU must exist before anything is created; a stale cart line is a 400, not a Stripe call.
  const unknown = items.find((i) => !catalog.product(i.sku))
  if (unknown) return new Response(`Unknown product ${unknown.sku}`, { status: 400 })

  const origin = readEnv(context, 'PUBLIC_SITE_URL') ?? context.url.origin
  const cancelUrl = `${origin}${returnTo}?checkout_error=cancelled`
  const metadata = { return_url: `${origin}${returnTo}` }

  try {
    // Preferred: the provider creates the hosted checkout itself. SKU.io does —
    // it prices the lines from the storefront's price list and opens the
    // session on the tenant's own processor, so this store holds no Stripe key.
    if (config.provider.createCheckout) {
      const checkout = await config.provider.createCheckout({
        items: items.map((i) => ({ sku: i.sku, quantity: clamp(i.quantity, config.checkout.maxQuantity) })),
        successUrl: `${origin}/checkout/success/?checkout_id={CHECKOUT_ID}`,
        cancelUrl,
        ...(shipping.enforced ? { shipToCountries: shipping.countries } : {}),
        metadata: { ...metadata, region },
      })
      if (!checkout.url) throw new Error(`checkout ${checkout.id} has no url`)
      return context.redirect(checkout.url, 303)
    }

    // Otherwise the store talks to Stripe directly. The price still comes from
    // the catalogue inside createStripeCheckout — the form only carries a SKU.
    const stripe = getStripe(context)
    if (!stripe) {
      console.error('checkout: no provider checkout and STRIPE_SECRET_KEY is not configured')
      return fail(context, returnTo, 'unavailable')
    }
    const session = await createStripeCheckout({
      stripe,
      catalog,
      config,
      items,
      successUrl: `${origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl,
      metadata,
      region,
    })
    return context.redirect(session.url, 303)
  } catch (error) {
    if (error instanceof CheckoutError && (error.code === 'unavailable' || error.code === 'no_shipping')) {
      return fail(context, returnTo, 'unavailable')
    }
    console.error('checkout: failed to create checkout', error)
    return fail(context, returnTo, 'error')
  }
}

/** GET is not a checkout action; send stray visitors to the catalogue. */
export function GET(context: APIContext): Response {
  return context.redirect(routes.shop(), 303)
}

function clamp(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1
}
