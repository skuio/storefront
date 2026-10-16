import type { APIContext } from 'astro'
import { store } from '../../lib/store'

export const prerender = false

/**
 * GET /api/discount?code=PODCAST → { ok: true, discount: { code, label, percentOff, amountOff } }
 * or { ok: false }. What the buyer is shown; the partner and commission never
 * leave the store. The order is priced again at checkout, so this is a preview.
 */
export function GET(context: APIContext): Response {
  const discount = store(context).partners.lookupCode(context.url.searchParams.get('code'))
  return new Response(JSON.stringify(discount ? { ok: true, discount } : { ok: false }), {
    status: discount ? 200 : 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
