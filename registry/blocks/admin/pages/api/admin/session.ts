import type { APIContext } from 'astro'
import { store } from '../../../lib/store'
import { clientAddress, safeNext, sameOrigin, writeOwnerSession } from '../../../lib/admin'

export const prerender = false

/** Password sign-in. One generic error for a wrong email or password; a lock after repeated failures. */
export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const next = safeNext(String(form.get('next') ?? ''))
  const back = (error: string) => context.redirect(`/admin/sign-in/?error=${error}&next=${encodeURIComponent(next)}`, 303)
  if (!sameOrigin(context.request, context.url)) return back('origin')
  const email = String(form.get('email') ?? '')
  const password = String(form.get('password') ?? '')
  if (!email.includes('@') || !password) return back('credentials')
  try {
    const session = await store(context).owners.signIn(email, password, clientAddress(context.request))
    if (!session) return back('credentials')
    writeOwnerSession(context.cookies, session.token, session.expiresAt, context.url.protocol === 'https:')
    return context.redirect(next, 303)
  } catch (error) {
    if ((error as { code?: string }).code === 'rate_limited') return back('locked')
    console.error('admin: sign-in failed', error)
    return back('credentials')
  }
}
