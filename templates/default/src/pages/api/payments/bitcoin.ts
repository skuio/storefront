import type { APIContext } from 'astro'
import { applyPaymentEvents } from '@skuio/storefront/payments'
import type { BitcoinPaymentAdapter } from '@skuio/storefront/payments/bitcoin'
import { paymentContext, paymentMethods, store } from '../../../lib/store'

export const prerender = false

/**
 * GET /api/payments/bitcoin?order=&key= — the bitcoin payment page polls this.
 * Returns the order's quote (address, amount, status). When the payment has
 * its confirmations the order is marked paid here, the same way a webhook would.
 */
export async function GET(context: APIContext): Promise<Response> {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const id = context.url.searchParams.get('order') ?? ''
  const key = context.url.searchParams.get('key') ?? ''
  const s = store(context)
  const order = id && key ? await s.orders.getWithKey(id, key) : null
  if (!order) return json({ ok: false }, 404)
  if (order.payment.status === 'paid') return json({ ok: true, status: 'paid' })
  const btc = paymentMethods(context).find((m) => m.id === 'bitcoin') as BitcoinPaymentAdapter | undefined
  if (!btc) return json({ ok: false, error: 'bitcoin is not offered' }, 404)
  try {
    const ctx = paymentContext(context)
    const events = await btc.verifyReturn!(context.url.searchParams, order, ctx)
    if (events.length) {
      await applyPaymentEvents(s, events)
      return json({ ok: true, status: 'paid' })
    }
    return json({ ok: true, ...(await btc.quote(order, ctx)) })
  } catch (error) {
    console.error('bitcoin status: explorer unavailable', error)
    return json({ ok: false, error: 'Could not reach the bitcoin network just now — retrying.' }, 503)
  }
}
