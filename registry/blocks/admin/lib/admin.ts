import type { APIContext, AstroCookies } from 'astro'
import type { Owner } from '@skuio/storefront/store'
import { sameOrigin, clientAddress } from '@skuio/storefront'
import { store, type StoreContext } from './store'

export { sameOrigin, clientAddress }

/**
 * The owner session lives in one httpOnly cookie, separate from the buyer's,
 * so a signed-in buyer never becomes a signed-in owner by accident.
 */
export const OWNER_COOKIE = 'skuio_owner_session'

export function readOwnerSession(cookies: AstroCookies): string | null {
  return cookies.get(OWNER_COOKIE)?.value || null
}

export function writeOwnerSession(cookies: AstroCookies, token: string, expiresAt: string, secure: boolean): void {
  cookies.set(OWNER_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: new Date(expiresAt) })
}

export function clearOwnerSession(cookies: AstroCookies): void {
  cookies.delete(OWNER_COOKIE, { path: '/' })
}

type PageContext = StoreContext & Pick<APIContext, 'cookies' | 'redirect'>

/**
 * The owner for this request, or a redirect to sign in that brings them back
 * to the page they asked for. Pages call `const owner = await requireOwner(Astro); if (owner instanceof Response) return owner`.
 */
export async function requireOwner(ctx: PageContext): Promise<Owner | Response> {
  const token = readOwnerSession(ctx.cookies)
  const owner = await store(ctx).owners.resolve(token)
  if (owner) return owner
  if (token) clearOwnerSession(ctx.cookies)
  const next = ctx.url.pathname + ctx.url.search
  return ctx.redirect(`/admin/sign-in/?next=${encodeURIComponent(next)}`, 303)
}

/** Only a path on this site is a valid post-sign-in destination; anything else is dropped. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/admin') || raw.startsWith('//') || raw.includes('\\')) return '/admin/'
  return raw
}

