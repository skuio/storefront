import type { APIContext } from 'astro'
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

export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const sku = String(form.get('sku') ?? '').trim()
  const quantity = Number(form.get('quantity') ?? 1)

  const product = catalog.product(sku)
  if (!product) return new Response('Unknown product', { status: 400 })

  const returnTo = routes.product(product, catalog)

  const stripe = getStripe(context)
  if (!stripe) {
    console.error('checkout: STRIPE_SECRET_KEY is not configured')
    return fail(context, returnTo, 'unavailable')
  }

  const origin = readEnv(context, 'PUBLIC_SITE_URL') ?? context.url.origin

  try {
    // Price comes from the catalogue inside createStripeCheckout — the form
    // only ever carries a SKU and a quantity.
    const session = await createStripeCheckout({
      stripe,
      catalog,
      config,
      items: [{ sku, quantity }],
      successUrl: `${origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}${returnTo}?checkout_error=cancelled`,
      metadata: { product_url: `${origin}${returnTo}` },
    })
    return context.redirect(session.url, 303)
  } catch (error) {
    if (error instanceof CheckoutError && error.code === 'unavailable') {
      return fail(context, returnTo, 'unavailable')
    }
    console.error('checkout: failed to create Stripe session', error)
    return fail(context, returnTo, 'error')
  }
}

/** GET is not a checkout action; send stray visitors to the catalogue. */
export function GET(context: APIContext): Response {
  return context.redirect(routes.shop(), 303)
}
