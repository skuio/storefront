import type { APIContext } from 'astro'
import { applyPaymentEvents } from '@skuio/storefront/payments'
import { StoreError } from '@skuio/storefront/store'
import { config, store } from '../../lib/store'
import { paypalExpressSetup } from '../../lib/paypal-express'
import { referredCode, referredSource } from '../../lib/referral'
import { touchMetadata } from '../../lib/attribution'

export const prerender = false

/**
 * PayPal express checkout — the PayPal / Venmo / Pay Later buttons (components/PayPalExpress.astro).
 * The buyer never sees the store's form: PayPal supplies the address from their account. Three
 * steps, driven by PayPal's JS SDK:
 *
 *   { action: 'create',   sku, quantity }              → { id }        a PayPal order, priced by the store
 *   { action: 'shipping', id, sku, quantity, country } → { ok }        re-priced for the address the buyer picked
 *   { action: 'complete', id, sku, quantity }          → { redirect }  store order created, linked, captured
 *
 * Only a SKU and a quantity come from the browser; every price is the store's. `complete` re-prices
 * for the buyer's real address and refuses to capture unless that equals what the buyer approved in
 * PayPal — so nothing is charged that the store would not charge.
 */
export async function POST(context: APIContext): Promise<Response> {
  const setup = paypalExpressSetup(context)
  if (!setup) return json({ ok: false, error: 'PayPal is not available' }, 404)
  let body: { action?: string; id?: string; sku?: string; quantity?: number | string; country?: string }
  try {
    body = await context.request.json()
  } catch {
    return json({ ok: false, error: 'Malformed request' }, 400)
  }
  const sku = typeof body.sku === 'string' ? body.sku.trim() : ''
  if (!sku) return json({ ok: false, error: 'Missing sku' }, 400)
  const s = store(context)
  const quantity = Math.max(1, Math.min(Number(body.quantity) || 1, config.checkout.maxQuantity))
  const items = [{ sku, quantity }]
  const code = referredCode(context)
  const id = typeof body.id === 'string' && /^[A-Z0-9]{5,40}$/.test(body.id) ? body.id : null

  try {
    if (body.action === 'create') {
      // Priced for the first ship-to country until PayPal reports the buyer's address.
      const quote = await s.checkout.quoteDefault(items, config.shipToCountries[0]!, code)
      return json({ ok: true, id: await setup.client.create(quote, { brandName: config.name }) })
    }

    if (body.action === 'shipping') {
      if (!id) return json({ ok: false, error: 'Missing order' }, 400)
      const country = String(body.country ?? '').toUpperCase()
      // Throws for a country the store does not ship to; the browser then rejects the address in PayPal.
      const quote = await s.checkout.quoteDefault(items, country, code)
      await setup.client.reprice(id, quote)
      return json({ ok: true })
    }

    if (body.action === 'complete') {
      if (!id) return json({ ok: false, error: 'Missing order' }, 400)
      const buyer = await setup.client.buyer(id)
      if (buyer.status !== 'APPROVED') return json({ ok: false, error: `PayPal order is ${buyer.status}` }, 409)
      const country = (buyer.shippingAddress.country ?? '').toUpperCase()
      const quote = await s.checkout.quoteDefault(items, country, code)
      if (quote.total !== buyer.amount.amount) {
        // The buyer approved a different amount than the store would charge: never capture it.
        console.warn('paypal-express: amount mismatch', { id, approved: buyer.amount.amount, quoted: quote.total })
        return json({ ok: false, error: 'The price changed — please try again.' }, 409)
      }
      const source = referredSource(context)
      const order = await s.checkout.createOrder({
        items,
        email: buyer.email,
        name: buyer.name,
        phone: buyer.phone,
        shippingAddress: buyer.shippingAddress,
        shippingOptionId: quote.option.id,
        discountCode: code,
        walletContact: true,
        metadata: {
          checkout: 'paypal-express',
          ...(source && code ? { ref_source: source } : {}),
          ...touchMetadata(context),
        },
      })
      await setup.client.attach(id, order, config.orders.numberPrefix)
      await s.orders.startPayment(order.id, { provider: 'paypal', kind: 'redirect' })
      const events = await setup.client.capture(id)
      await applyPaymentEvents(s, events)
      if (!events.some((e) => e.type === 'paid')) return json({ ok: false, error: 'PayPal did not complete the payment.', retry: true }, 402)
      return json({ ok: true, redirect: `/checkout/success/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}&provider=paypal` })
    }

    return json({ ok: false, error: 'Unknown action' }, 400)
  } catch (error) {
    if (error instanceof StoreError) return json({ ok: false, error: error.message, details: error.details }, error.status)
    const message = String((error as Error)?.message ?? error)
    // A declined funding source: PayPal's guidance is to restart so the buyer can pick another.
    if (message.includes('INSTRUMENT_DECLINED')) return json({ ok: false, error: 'That payment method was declined.', retry: true }, 402)
    console.error('paypal-express: failed', body.action, message)
    return json({ ok: false, error: 'PayPal is temporarily unavailable.' }, 502)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
