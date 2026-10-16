import type { APIContext } from 'astro'
import { sameOrigin } from '@skuio/storefront'
import { store } from '../../../lib/store'

export const prerender = false

/**
 * Email a partner their dashboard sign-in link. The answer is identical whether
 * or not the address belongs to a partner, so it cannot be used to enumerate them.
 */
export async function POST(context: APIContext): Promise<Response> {
  if (!sameOrigin(context.request, context.url)) return context.redirect('/partners/', 303)
  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  if (!email.includes('@')) return context.redirect('/partners/', 303)
  try {
    await store(context).partners.sendSignInLink(email)
  } catch (error) {
    console.error('partners: sendSignInLink failed', error)
  }
  return context.redirect('/partners/?sent=1', 303)
}
