import type { APIContext } from 'astro'
import { store } from '../../../lib/store'
import { sameOrigin } from '../../../lib/admin'

export const prerender = false

/**
 * Email a password-reset link. The response is identical whether or not the
 * address belongs to an owner, so this cannot be used to enumerate owners.
 */
export async function POST(context: APIContext): Promise<Response> {
  if (!sameOrigin(context.request, context.url)) return context.redirect('/admin/forgot-password/', 303)
  const form = await context.request.formData()
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  if (!email.includes('@')) return context.redirect('/admin/forgot-password/', 303)
  try {
    await store(context).owners.sendResetLink(email)
  } catch (error) {
    // Logged, not surfaced: the visitor sees the same "check your email" either way.
    console.error('admin: sendResetLink failed', error)
  }
  return context.redirect('/admin/forgot-password/?sent=1', 303)
}
