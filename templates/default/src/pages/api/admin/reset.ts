import type { APIContext } from 'astro'
import { store } from '../../../lib/store'
import { clearOwnerSession, sameOrigin } from '../../../lib/admin'

export const prerender = false

/** Exchange a reset token for a new password. Every session of that owner ends. */
export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()
  const token = String(form.get('token') ?? '')
  const password = String(form.get('password') ?? '')
  const confirm = String(form.get('confirm') ?? '')
  const back = (error: string) => context.redirect(`/admin/reset-password/?token=${encodeURIComponent(token)}&error=${error}`, 303)
  if (!sameOrigin(context.request, context.url)) return back('origin')
  if (!token) return context.redirect('/admin/forgot-password/', 303)
  if (password !== confirm) return back('mismatch')
  try {
    await store(context).owners.resetPassword(token, password)
    clearOwnerSession(context.cookies)
    return context.redirect('/admin/sign-in/?reset=1', 303)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'validation_failed') return back('weak')
    if (code === 'not_found') return context.redirect('/admin/forgot-password/?error=link', 303)
    console.error('admin: reset failed', error)
    return back('unknown')
  }
}
