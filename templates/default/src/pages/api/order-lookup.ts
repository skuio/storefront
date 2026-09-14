import type { APIContext } from 'astro'
import { store } from '../../lib/store'

export const prerender = false

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Guest order status by email + order number, straight from the store.
 *
 * Both factors are required: the number alone is guessable, the email alone
 * would enumerate someone's orders.
 */
export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  const reference = String(form.get('reference') ?? '').trim()
  if (!email.includes('@') || !reference) return json({ ok: false, error: 'missing_fields' }, 400)

  try {
    const order = await store(context).orders.byNumberAndEmail(reference, email)
    if (!order) return json({ ok: false, error: 'not_found' }, 404)
    const latest = order.fulfillments.find((f) => f.trackingNumber) ?? order.fulfillments[0]
    const a = order.shippingAddress
    return json({
      ok: true,
      order: {
        number: order.number,
        status: order.status,
        createdAt: order.createdAt,
        paymentStatus: order.payment.status,
        total: order.total,
        lines: order.lines.map((l) => ({ name: l.name, quantity: l.quantity, fulfilledQuantity: l.fulfilledQuantity })),
        shipTo: [a.city, a.state, a.country].filter(Boolean).join(', ') || null,
        tracking: latest?.trackingNumber ? { number: latest.trackingNumber, carrier: latest.carrier, url: latest.trackingUrl } : null,
      },
    })
  } catch (error) {
    console.error('order-lookup: failed', error)
    return json({ ok: false, error: 'lookup_failed' }, 502)
  }
}
