import type { APIContext } from 'astro'
import { sameOrigin } from '@skuio/storefront'
import { store } from '../../../lib/store'
import { clearPartnerSession, readPartnerSession } from '../../../lib/partner-session'

export const prerender = false

export async function POST(context: APIContext): Promise<Response> {
  if (!sameOrigin(context.request, context.url)) return context.redirect('/partners/', 303)
  await store(context).partners.signOut(readPartnerSession(context.cookies)).catch(() => {})
  clearPartnerSession(context.cookies)
  return context.redirect('/partners/', 303)
}
