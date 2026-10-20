import { defineMiddleware } from 'astro:middleware'
import { captureReferral } from './lib/referral'
import { captureTouch } from './lib/attribution'
import { sweepPayments } from './lib/payment-sweep'
import { readEnv } from './lib/store'

/**
 * Runs on every request before the page renders, and on the response after.
 *
 *  - CANONICAL_HOST (optional): one host for every page. A GET/HEAD on any other host is 301'd
 *    there with its path and query (www → apex or apex → www), so search engines and links see one
 *    copy of each page. Other methods pass through: a processor's webhook must never be redirected.
 *    localhost and *.workers.dev previews are left alone.
 *  - A partner's ?code= link keeps their discount applied through to checkout (captureReferral),
 *    the first and last marketing touch is recorded for the order (captureTouch), and stale
 *    payments are swept (sweepPayments).
 *  - HTML is `cache-control: no-cache` unless the page set its own: pages render per request and
 *    hashed assets cache forever, so a cached page from the previous deploy would point at
 *    stylesheets that no longer exist and render unstyled.
 *  - STORE_PREVIEW=1: a shareable preview is never indexed (`x-robots-tag`; BaseLayout adds the
 *    meta tag and a banner).
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const canonical = readEnv(context, 'CANONICAL_HOST')?.trim().toLowerCase()
  const host = context.url.hostname.toLowerCase()
  if (
    canonical &&
    host !== canonical &&
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    !host.endsWith('.workers.dev') &&
    (context.request.method === 'GET' || context.request.method === 'HEAD')
  ) {
    const to = new URL(context.url)
    to.hostname = canonical
    return new Response(null, { status: 301, headers: { location: to.toString() } })
  }

  if (!context.isPrerendered) {
    captureReferral(context)
    captureTouch(context)
    sweepPayments(context)
  }

  const response = await next()
  const headers: Record<string, string> = {}
  if ((response.headers.get('content-type') ?? '').includes('text/html') && !response.headers.has('cache-control')) {
    headers['cache-control'] = 'no-cache'
  }
  if (readEnv(context, 'STORE_PREVIEW') === '1') headers['x-robots-tag'] = 'noindex, nofollow'
  return withHeaders(response, headers)
})

/** Set headers on a response; a response with immutable headers (a fetched one, a redirect) is copied first. */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  const entries = Object.entries(headers)
  if (entries.length === 0) return response
  try {
    for (const [k, v] of entries) response.headers.set(k, v)
    return response
  } catch {
    const copy = new Response(response.body, response)
    for (const [k, v] of entries) copy.headers.set(k, v)
    return copy
  }
}
