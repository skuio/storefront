import type { APIContext } from 'astro'
import { config } from '../../../lib/catalog'
import { clearSession, readSession } from '../../../lib/account'

export const prerender = false

export async function POST(context: APIContext): Promise<Response> {
  const token = readSession(context.cookies)
  clearSession(context.cookies)
  if (token && config.provider.customers) {
    // Best effort: the cookie is gone either way.
    await config.provider.customers.revoke(token).catch((e) => console.warn('account: revoke failed', e))
  }
  return context.redirect('/', 303)
}
