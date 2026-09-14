import type { AstroCookies } from 'astro'

/**
 * The customer session lives in one httpOnly cookie. Page JavaScript can
 * never read it; only server code exchanges it with the store.
 */
export const SESSION_COOKIE = 'skuio_customer_session'

export function readSession(cookies: AstroCookies): string | null {
  return cookies.get(SESSION_COOKIE)?.value || null
}

export function writeSession(cookies: AstroCookies, token: string, expiresAt: string, secure: boolean): void {
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  })
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' })
}
