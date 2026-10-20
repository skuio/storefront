import type { APIContext } from 'astro'
import { config, routes, store } from '../lib/store'

export const prerender = false

/** Pages a store always has; add your own static pages here. */
const STATIC = ['/', '/about/', '/contact/', '/shipping/', '/returns/', '/terms/', '/privacy/']

/**
 * Sitemap from the live catalog. Catalog pages are server-rendered, so a
 * build-time sitemap would not know about them; this one is always current.
 */
export async function GET(context: APIContext): Promise<Response> {
  const catalog = await store(context).catalog.load()
  const urls = [
    ...STATIC.map((p) => ({ loc: p })),
    { loc: routes.shop() },
    ...catalog.nonEmptyCategories().map((c) => ({ loc: routes.category(c) })),
    ...catalog.products.map((p) => ({ loc: routes.product(p, catalog) })),
  ]
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escape(new URL(u.loc, config.url).href)}</loc></url>`).join('\n')}
</urlset>
`
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
