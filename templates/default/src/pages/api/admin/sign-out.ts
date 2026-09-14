import type { APIContext } from 'astro'
import { store } from '../../../lib/store'
import { clearOwnerSession, readOwnerSession } from '../../../lib/admin'

export const prerender = false

export async function POST(context: APIContext): Promise<Response> {
  const token = readOwnerSession(context.cookies)
  clearOwnerSession(context.cookies)
  // Best effort: the cookie is gone either way.
  await store(context).owners.signOut(token).catch((e) => console.warn('admin: sign-out failed', e))
  return context.redirect('/admin/sign-in/', 303)
}
