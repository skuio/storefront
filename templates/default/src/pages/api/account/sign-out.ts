import type { APIContext } from 'astro'
import { store } from '../../../lib/store'
import { clearSession, readSession } from '../../../lib/account'

export const prerender = false

export async function POST(context: APIContext): Promise<Response> {
  const token = readSession(context.cookies)
  clearSession(context.cookies)
  // Best effort: the cookie is gone either way.
  await store(context).sessions.signOut(token).catch((e) => console.warn('account: sign-out failed', e))
  return context.redirect('/', 303)
}
