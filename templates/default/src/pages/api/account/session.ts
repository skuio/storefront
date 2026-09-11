import type { APIContext } from 'astro'
import { config } from '../../../lib/catalog'
import { readEnv } from '../../../lib/stripe'

export const prerender = false

/**
 * Ask the provider to email a sign-in link. The response is identical whether
 * or not the address is known, so this cannot be used to enumerate customers.
 */
export async function POST(context: APIContext): Promise<Response> {
  const customers = config.provider.customers
  if (!customers) return context.redirect('/account/', 303)

  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  if (!email.includes('@')) return context.redirect('/account/', 303)

  const origin = readEnv(context, 'PUBLIC_SITE_URL') ?? context.url.origin
  try {
    await customers.requestSession(email, `${origin}/account/verify/`)
  } catch (error) {
    // Logged, not surfaced: the customer sees the same "check your email" either way.
    console.error('account: requestSession failed', error)
  }
  return context.redirect('/account/?sent=1', 303)
}
