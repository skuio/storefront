import type { APIContext } from 'astro'
import { sameOrigin } from '@skuio/storefront'
import { StoreError, type QuoteRequestInput } from '@skuio/storefront/store'
import { store } from '../../lib/store'
import { readSession } from '../../lib/account'
import { quotePath } from '../../lib/quotes'

export const prerender = false

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Request a quote. No account is needed: a guest gives a name and an email and gets back a link (and an email) to
 * the quote. A signed-in buyer's request is filed under their account whatever email the form carries.
 *
 * Accepts JSON from the quote page (`{ items: [{ sku, quantity }], email, name, company, phone, message,
 * shipping_address }`) or a plain form post (the no-JavaScript fallback, `items` as JSON or a single `sku` +
 * `quantity`). Only SKUs and quantities are read; the merchant sets every price.
 */
export async function POST(context: APIContext): Promise<Response> {
  const wantsJson = (context.request.headers.get('content-type') ?? '').includes('application/json')
  if (!sameOrigin(context.request, context.url)) return json({ ok: false, error: { code: 'forbidden', message: 'Cross-site request refused', details: null } }, 403)

  let body: Record<string, unknown>
  try {
    body = wantsJson ? ((await context.request.json()) as Record<string, unknown>) : Object.fromEntries((await context.request.formData()).entries())
  } catch {
    return reply(context, wantsJson, { ok: false, error: { code: 'validation_failed', message: 'Malformed request', details: null } }, 422)
  }
  // Honeypot — a real browser leaves it empty. Answer as if it worked so bots learn nothing.
  if (str(body.website)) return reply(context, wantsJson, { ok: true, redirect: '/quote/?sent=1' })

  const s = store(context)
  const customer = await s.sessions.resolve(readSession(context.cookies))
  const a = (body.shipping_address && typeof body.shipping_address === 'object' ? body.shipping_address : {}) as Record<string, unknown>
  const input: QuoteRequestInput = {
    items: items(body.items, str(body.sku), str(body.quantity)),
    email: customer?.email ?? str(body.email),
    name: str(body.name) || customer?.name || '',
    phone: str(body.phone) || null,
    company: str(body.company) || null,
    message: str(body.message) || null,
    shippingAddress: {
      name: str(a.name) || str(body.ship_name),
      line1: str(a.line1) || str(body.ship_line1),
      line2: str(a.line2) || str(body.ship_line2),
      city: str(a.city) || str(body.ship_city),
      state: str(a.state) || str(body.ship_state),
      postalCode: str(a.postal_code) || str(body.ship_postal_code),
      country: str(a.country) || str(body.ship_country),
    },
  }
  try {
    const quote = await s.quotes.request(input)
    const redirect = quotePath(quote, { sent: '1' })
    return wantsJson ? json({ ok: true, redirect, quote: { id: quote.id, number: `${s.config.quotes.numberPrefix}${quote.number}` } }) : context.redirect(redirect, 303)
  } catch (error) {
    if (error instanceof StoreError) return reply(context, wantsJson, { ok: false, error: { code: error.code, message: error.message, details: error.details } }, error.status)
    console.error('quotes: request failed', error)
    return reply(context, wantsJson, { ok: false, error: { code: 'quote_failed', message: 'Quote requests are temporarily unavailable', details: null } }, 502)
  }
}

export function GET(context: APIContext): Response {
  return context.redirect('/quote/', 303)
}

function reply(context: APIContext, wantsJson: boolean, body: { ok: boolean; redirect?: string; error?: { code: string; message: string; details: Record<string, string> | null } }, status = 200): Response {
  if (wantsJson) return json(body, status)
  if (body.ok) return context.redirect(body.redirect ?? '/quote/', 303)
  const url = new URL('/quote/', context.url.origin)
  url.searchParams.set('error', body.error?.code ?? 'failed')
  if (body.error?.details) url.searchParams.set('fields', Object.keys(body.error.details).join(','))
  return context.redirect(url.pathname + url.search, 303)
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

function items(raw: unknown, sku: string, quantity: string): { sku: string; quantity: number }[] {
  let list: unknown = raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      list = JSON.parse(raw)
    } catch {
      list = []
    }
  }
  const out = Array.isArray(list)
    ? list.map((x) => ({ sku: str((x as { sku?: unknown })?.sku), quantity: Number((x as { quantity?: unknown })?.quantity ?? 1) })).filter((x) => x.sku)
    : []
  if (out.length === 0 && sku) out.push({ sku, quantity: Number(quantity || 1) })
  return out
}
