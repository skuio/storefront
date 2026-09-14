/**
 * Framework-agnostic request helpers for browser form endpoints. The store
 * disables Astro's global origin check so the bearer-authenticated Store API
 * (machine traffic, no Origin header) is never rejected; these keep the
 * browser form POSTs same-origin instead.
 */

/**
 * True when the request is a same-origin browser navigation/form post, or a
 * non-browser call (no Origin, no Sec-Fetch-Site — e.g. the Store API). False
 * only when a cross-site browser context is explicit. Use it to guard mutating
 * form handlers: `if (!sameOrigin(request, url)) return reject`.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) return false
  return true
}

/** The caller's address, from Cloudflare's header first, then a proxy's. */
export function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
