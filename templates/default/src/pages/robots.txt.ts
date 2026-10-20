import type { APIContext } from 'astro'
import { readEnv, siteUrl } from '../lib/store'

export const prerender = false

/**
 * robots.txt, rendered so it can name the sitemap by absolute URL (a `Sitemap:` line must be
 * absolute, and the origin is PUBLIC_SITE_URL in production). Add Disallow lines for any other
 * private area you build. A STORE_PREVIEW=1 deploy disallows everything.
 */
export function GET(context: APIContext): Response {
  const preview = readEnv(context, 'STORE_PREVIEW') === '1'
  const rules = preview
    ? ['Disallow: /']
    : ['Allow: /', 'Disallow: /api/', 'Disallow: /checkout/', 'Disallow: /account/', 'Disallow: /admin/', 'Disallow: /partners/']
  const body = ['User-agent: *', ...rules, '', `Sitemap: ${siteUrl(context)}/sitemap.xml`, ''].join('\n')
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}
