import { expect, test } from '@playwright/test'

/**
 * What crawlers and caches see. Same dev server and local D1 as checkout.spec.ts.
 */

test('robots.txt names an absolute sitemap that answers with XML', async ({ request }) => {
  const robots = await request.get('/robots.txt')
  expect(robots.status()).toBe(200)
  const body = await robots.text()
  expect(body).toContain('User-agent: *')
  const line = body.split('\n').find((l) => l.startsWith('Sitemap: '))
  expect(line, 'robots.txt must advertise the sitemap').toBeTruthy()
  const advertised = new URL(line!.slice('Sitemap: '.length).trim()) // throws unless absolute
  const sitemap = await request.get(advertised.pathname)
  expect(sitemap.status()).toBe(200)
  expect(sitemap.headers()['content-type']).toContain('xml')
  const xml = await sitemap.text()
  expect(xml).toContain('<urlset')
  expect(xml).toContain('<loc>')
})

test('pages are served no-cache so a deploy never strands HTML on old assets', async ({ request }) => {
  for (const path of ['/', '/shop/']) {
    const res = await request.get(path)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/html')
    expect(res.headers()['cache-control'], `${path} cache-control`).toContain('no-cache')
  }
})

test('a category page renders its description as HTML and gives the meta description plain text', async ({ page }) => {
  // src/data/categories.json seeds "gear" with an HTML description.
  await page.goto('/collections/gear/')
  const description = page.locator('[data-category-description]')
  await expect(description.locator('strong')).toHaveText('trail')
  expect(await description.innerHTML()).not.toContain('&lt;')
  const meta = await page.locator('meta[name="description"]').getAttribute('content')
  expect(meta).toBe('Bags and carry for the trail and the commute.')
})
