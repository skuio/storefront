import type { APIContext } from 'astro'
import { store } from '../../../lib/store'

export const prerender = false

/**
 * Email a sign-in link. The response is identical whether or not the address
 * belongs to a customer, so this cannot be used to enumerate customers.
 */
export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  if (!email.includes('@')) return context.redirect('/account/', 303)
  try {
    await store(context).sessions.sendMagicLink(email)
  } catch (error) {
    // Logged, not surfaced: the customer sees the same "check your email" either way.
    console.error('account: sendMagicLink failed', error)
  }
  return context.redirect('/account/?sent=1', 303)
}
