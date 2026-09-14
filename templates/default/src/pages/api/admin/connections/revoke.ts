import type { APIContext } from 'astro'
import { store } from '../../../../lib/store'
import { readOwnerSession, sameOrigin } from '../../../../lib/admin'

export const prerender = false

/** Revoke one connection. Its key is a 401 from the next request on. */
export async function POST(context: APIContext): Promise<Response> {
  const s = store(context)
  const owner = await s.owners.resolve(readOwnerSession(context.cookies))
  if (!owner) return context.redirect('/admin/sign-in/?next=%2Fadmin%2Fconnections%2F', 303)
  if (!sameOrigin(context.request, context.url)) return context.redirect('/admin/connections/', 303)
  const form = await context.request.formData()
  const id = String(form.get('id') ?? '')
  if (id) await s.connections.revoke(id)
  return context.redirect('/admin/connections/?revoked=1', 303)
}
