import type { APIContext } from 'astro'
import { orderFromSession, referenceFromSessionId } from '@skuio/storefront/stripe'
import { getStripe } from '../../lib/stripe'

export const prerender = false

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Order status by email + reference, read live from Stripe.
 *
 * Both factors are required: the reference alone is guessable from a receipt,
 * the email alone would enumerate someone's orders. Tracking comes from the
 * PaymentIntent's shipping record, which is where fulfilment writes it.
 */
export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  const reference = String(form.get('reference') ?? '').trim().toUpperCase()
  if (!email.includes('@') || reference.length < 6) return json({ ok: false, error: 'missing_fields' }, 400)

  const stripe = getStripe(context)
  if (!stripe) return json({ ok: false, error: 'not_configured' }, 500)

  try {
    const sessions = await stripe.checkout.sessions.list({
      customer_details: { email },
      limit: 20,
      expand: ['data.line_items', 'data.line_items.data.price.product', 'data.payment_intent'],
    })

    const match = sessions.data.find((s) => referenceFromSessionId(s.id) === reference)
    if (!match) return json({ ok: false, error: 'not_found' }, 404)

    const order = orderFromSession(match)
    const pi = typeof match.payment_intent === 'object' ? match.payment_intent : null
    const shipping = pi?.shipping ?? null

    return json({
      ok: true,
      order: {
        reference: order.reference,
        createdAt: order.createdAt,
        paymentStatus: match.payment_status,
        total: order.total,
        lines: order.lines.map((l) => ({ name: l.name, quantity: l.quantity })),
        shipTo: order.shippingAddress
          ? [order.shippingAddress.city, order.shippingAddress.state, order.shippingAddress.country].filter(Boolean).join(', ')
          : null,
        tracking: shipping?.tracking_number ? { number: shipping.tracking_number, carrier: shipping.carrier ?? null } : null,
      },
    })
  } catch (error) {
    console.error('order-lookup: Stripe query failed', error)
    return json({ ok: false, error: 'lookup_failed' }, 502)
  }
}
