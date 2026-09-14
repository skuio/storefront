import type { APIContext } from 'astro'
import { StoreError, type CheckoutInput } from '@skuio/storefront/store'
import { payment, paymentContext, store } from '../../lib/store'

export const prerender = false

/**
 * Create the order, then hand it to the payment adapter.
 *
 * Accepts the checkout page's form (application/x-www-form-urlencoded) or
 * JSON. Only SKUs and quantities are read from the client; every price comes
 * from the store. A form post answers with a 303 (to the processor, to the
 * pending page, or back to /checkout/ with an error); JSON answers with
 * `{ ok, redirect }` or `{ ok: false, error: { code, message, details } }`.
 */
export async function POST(context: APIContext): Promise<Response> {
  const wantsJson = (context.request.headers.get('content-type') ?? '').includes('application/json')
  let input: CheckoutInput
  let direct: { sku: string; quantity: string } | null = null
  try {
    if (wantsJson) input = fromJson(await context.request.json())
    else {
      const form = await context.request.formData()
      input = fromForm(form)
      const sku = form.get('sku')
      if (typeof sku === 'string' && sku) direct = { sku, quantity: String(form.get('quantity') ?? '1') }
    }
  } catch {
    return wantsJson ? json({ ok: false, error: { code: 'validation_failed', message: 'Malformed request', details: null } }, 422) : bounce(context, 'invalid', null, direct)
  }

  const s = store(context)
  // Lazy housekeeping: processor checkouts abandoned for 24h become cancelled (cheap, indexed).
  await s.orders.expireAbandoned().catch((e) => console.warn('checkout: expireAbandoned failed', e))
  try {
    const order = await s.checkout.createOrder(input)
    const adapter = payment(context)
    const start = await adapter.start(order, paymentContext(context))
    await s.orders.startPayment(order.id, { provider: adapter.id, kind: start.kind })
    let redirect: string
    if (start.kind === 'redirect') {
      redirect = start.url
    } else {
      // Pay-later adapters: the order is placed, the buyer gets a receipt and instructions.
      await s.orders.notifyReceived(order)
      redirect = `/checkout/pending/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}`
    }
    return wantsJson ? json({ ok: true, redirect, order: { id: order.id, number: order.number } }) : context.redirect(redirect, 303)
  } catch (error) {
    if (error instanceof StoreError) {
      return wantsJson
        ? json({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, error.status)
        : bounce(context, 'validation', error.details, direct)
    }
    console.error('checkout: failed', error)
    return wantsJson ? json({ ok: false, error: { code: 'checkout_failed', message: 'Checkout is temporarily unavailable', details: null } }, 502) : bounce(context, 'unavailable', null, direct)
  }
}

/** GET is not a checkout action; send stray visitors to the checkout page. */
export function GET(context: APIContext): Response {
  return context.redirect('/checkout/', 303)
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** No-JavaScript fallback: back to the form with the reason. The page re-fills Buy Now from the query. */
function bounce(context: APIContext, reason: string, details: Record<string, string> | null, direct: { sku: string; quantity: string } | null): Response {
  const url = new URL('/checkout/', context.url.origin)
  url.searchParams.set('error', reason)
  if (details) url.searchParams.set('fields', Object.keys(details).join(','))
  if (direct) {
    url.searchParams.set('sku', direct.sku)
    url.searchParams.set('quantity', direct.quantity)
  }
  return context.redirect(url.pathname + url.search, 303)
}

function items(raw: unknown, sku?: string | null, quantity?: string | number | null): { sku: string; quantity: number }[] {
  let list: unknown = raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      list = JSON.parse(raw)
    } catch {
      list = []
    }
  }
  const out = Array.isArray(list)
    ? list
        .map((x) => ({ sku: String((x as { sku?: unknown })?.sku ?? '').trim(), quantity: Number((x as { quantity?: unknown })?.quantity ?? 1) }))
        .filter((x) => x.sku)
    : []
  if (out.length === 0 && sku) out.push({ sku: String(sku).trim(), quantity: Number(quantity ?? 1) })
  return out
}

function fromForm(form: FormData): CheckoutInput {
  const get = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v : ''
  }
  return {
    items: items(get('items'), get('sku'), get('quantity')),
    email: get('email'),
    name: get('name') || null,
    phone: get('phone') || null,
    shippingAddress: {
      name: get('ship_name') || get('name'),
      line1: get('ship_line1'),
      line2: get('ship_line2'),
      city: get('ship_city'),
      state: get('ship_state'),
      postalCode: get('ship_postal_code'),
      country: get('ship_country'),
    },
    shippingOptionId: get('shipping_option'),
    notes: get('notes') || null,
  }
}

function fromJson(body: unknown): CheckoutInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const a = (b.shipping_address && typeof b.shipping_address === 'object' ? b.shipping_address : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    items: items(b.items, str(b.sku), typeof b.quantity === 'number' ? b.quantity : str(b.quantity)),
    email: str(b.email),
    name: str(b.name) || null,
    phone: str(b.phone) || null,
    shippingAddress: {
      name: str(a.name) || str(b.name),
      line1: str(a.line1),
      line2: str(a.line2),
      city: str(a.city),
      state: str(a.state),
      postalCode: str(a.postal_code),
      country: str(a.country),
    },
    shippingOptionId: str(b.shipping_option),
    notes: str(b.notes) || null,
    ...(b.metadata && typeof b.metadata === 'object' ? { metadata: b.metadata as Record<string, string> } : {}),
  }
}
