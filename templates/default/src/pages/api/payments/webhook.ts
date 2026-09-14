import type { APIContext } from 'astro'
import { applyPaymentEvents, PaymentWebhookError } from '@skuio/storefront/payments'
import { payment, paymentContext, store } from '../../../lib/store'

export const prerender = false

/**
 * Processor callback, adapter-neutral. The adapter verifies the signature and
 * decodes what happened; the store applies it. A paid order is born here —
 * the success page is a courtesy the buyer can skip by closing the tab.
 *
 * Every store method underneath is idempotent, so a redelivered event is
 * harmless. A 5xx makes the processor retry, which is what we want when the
 * database is briefly unavailable.
 */
export async function POST(context: APIContext): Promise<Response> {
  const adapter = payment(context)
  let events
  try {
    events = await adapter.handleWebhook(context.request, paymentContext(context))
  } catch (error) {
    if (error instanceof PaymentWebhookError) {
      console.warn('webhook: rejected', error.message)
      return new Response(error.message, { status: error.status })
    }
    console.error('webhook: failed to decode', error)
    return new Response('error', { status: 500 })
  }

  try {
    const touched = await applyPaymentEvents(store(context), events)
    console.log('webhook: applied', JSON.stringify({ provider: adapter.id, events: events.map((e) => e.type), orders: touched.map((o) => `${o.number}:${o.status}`) }))
    return new Response('ok', { status: 200 })
  } catch (error) {
    console.error('webhook: failed to apply events', error)
    return new Response('handler failed', { status: 500 })
  }
}
