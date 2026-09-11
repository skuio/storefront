import type { APIContext } from 'astro'
import { parseStripeWebhook, WebhookSignatureError } from '@skuio/storefront/stripe'
import { getStripe, readEnv } from '../../lib/stripe'
import { onOrderCompleted } from '../../lib/orders'

export const prerender = false

/**
 * Stripe webhook receiver.
 *
 * Checkout only becomes an order here — the success page is a courtesy the
 * customer can skip by closing the tab, so nothing that matters may depend on
 * it. What happens to a completed order lives in src/lib/orders.ts.
 */
export async function POST(context: APIContext): Promise<Response> {
  const stripe = getStripe(context)
  const secret = readEnv(context, 'STRIPE_WEBHOOK_SECRET')
  if (!stripe || !secret) {
    console.error('webhook: Stripe is not configured')
    return new Response('not configured', { status: 500 })
  }

  const signature = context.request.headers.get('stripe-signature')
  if (!signature) return new Response('missing signature', { status: 400 })

  let event
  try {
    event = await parseStripeWebhook({ stripe, payload: await context.request.text(), signature, secret })
  } catch (error) {
    if (error instanceof WebhookSignatureError) return new Response('invalid signature', { status: 400 })
    console.error('webhook: failed to parse event', error)
    return new Response('error', { status: 500 })
  }

  // Acknowledge everything else so Stripe stops retrying.
  if (event.type !== 'order.completed') return new Response('ignored', { status: 200 })

  // Logged before any side effect: the Worker log is the durable record even if
  // the handler below fails.
  console.log('order.completed', JSON.stringify({
    reference: event.order.reference,
    session: event.order.processorSessionId,
    total: event.order.total,
    skus: event.order.lines.map((l) => l.sku),
    email: event.order.customer.email,
  }))

  try {
    await onOrderCompleted(event.order, context)
  } catch (error) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    console.error('webhook: onOrderCompleted failed', error)
    return new Response('handler failed', { status: 500 })
  }

  return new Response('ok', { status: 200 })
}
