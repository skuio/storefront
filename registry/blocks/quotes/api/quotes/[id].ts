import type { APIContext } from 'astro'
import { sameOrigin } from '@skuio/storefront'
import { StoreError } from '@skuio/storefront/store'
import { store } from '../../../lib/store'
import { quoteForViewer, quotePath } from '../../../lib/quotes'

export const prerender = false

/**
 * The buyer's answer to a priced quote: `action=accept` (places a pay-later order at the quoted prices; needs a
 * shipping address, taken from the form or from the request) or `action=decline` (with an optional `reason`). The quote's
 * access `key` authorises a guest; a signed-in buyer needs nothing more. Always answers with a 303 back to the quote.
 */
export async function POST(context: APIContext): Promise<Response> {
  if (!sameOrigin(context.request, context.url)) return new Response('Cross-site request refused', { status: 403 })
  const form = await context.request.formData()
  const get = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v.trim() : ''
  }
  const s = store(context)
  const quote = await quoteForViewer(s, context.cookies, context.params.id ?? '', get('key') || null)
  if (!quote) return new Response(null, { status: 404 })

  try {
    if (get('action') === 'accept') {
      const hasAddress = get('ship_line1') || get('ship_city')
      await s.quotes.accept(quote.id, {
        shippingAddress: hasAddress
          ? { name: get('ship_name'), line1: get('ship_line1'), line2: get('ship_line2'), city: get('ship_city'), state: get('ship_state'), postalCode: get('ship_postal_code'), country: get('ship_country') }
          : null,
        phone: get('phone') || null,
        poNumber: get('po_number') || null,
        notes: get('notes') || null,
      })
      return context.redirect(quotePath(quote, { done: 'accepted' }), 303)
    }
    if (get('action') === 'decline') {
      await s.quotes.decline(quote.id, get('reason') || null)
      return context.redirect(quotePath(quote, { done: 'declined' }), 303)
    }
    return context.redirect(quotePath(quote), 303)
  } catch (error) {
    if (error instanceof StoreError) {
      const params: Record<string, string> = { error: error.code }
      if (error.details) params.fields = Object.keys(error.details).join(',')
      return context.redirect(quotePath(quote, params), 303)
    }
    console.error('quotes: answer failed', error)
    return context.redirect(quotePath(quote, { error: 'unavailable' }), 303)
  }
}
