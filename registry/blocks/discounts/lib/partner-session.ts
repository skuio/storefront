import type { AstroCookies } from 'astro'

/** The partner portal's session cookie (separate from the customer portal's). */
export const PARTNER_COOKIE = 'sf_partner'

export function readPartnerSession(cookies: AstroCookies): string | null {
  return cookies.get(PARTNER_COOKIE)?.value ?? null
}

export function writePartnerSession(cookies: AstroCookies, token: string, expiresAt: string, secure: boolean): void {
  cookies.set(PARTNER_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires: new Date(expiresAt) })
}

export function clearPartnerSession(cookies: AstroCookies): void {
  cookies.delete(PARTNER_COOKIE, { path: '/' })
}
