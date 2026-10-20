import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'

/**
 * The guardrail. Change anything you like about this store; keep this green.
 *
 * Runs against the dev server on the local D1 database (see playwright.config.ts)
 * with the `manual` payment adapter, so no processor account is needed: an
 * order is placed, lands on the pending page, and is then marked paid and
 * shipped through the Store API — the full loop an operations system drives.
 */
// The dev server reads STORE_API_KEY from .dev.vars when that file exists, else from the
// environment playwright.config.ts passes it. Use whichever the server is using.
function devVar(name: string): string | undefined {
  const file = new URL('../.dev.vars', import.meta.url)
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || undefined
}
const API_KEY = devVar('STORE_API_KEY') ?? process.env.STORE_API_KEY ?? 'e2e-store-api-key-e2e-store-api-key'
const api = { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }
// Astro's CSRF protection (security.checkOrigin) 403s a form POST whose Origin does not
// match the site — correct for production, so the tests send it like a browser would.
const browser = { Origin: 'http://localhost:4321' }

test('home page lists categories and links into the catalogue', async ({ page, request }) => {
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 15_000 })
  const links = page.locator('a[href^="/collections/"], a[href^="/products/"]')
  expect(await links.count()).toBeGreaterThan(0)
  // Links must resolve, not merely exist.
  const hrefs = [...new Set(await links.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!)))]
  for (const href of hrefs.slice(0, 6)) {
    const res = await request.get(href)
    expect(res.status(), `${href} should resolve`).toBe(200)
  }
})

test('product page has a buy form that carries a SKU and no price', async ({ page, request }) => {
  const health = await (await request.get('/api/skuio/v1/health', { headers: api })).json()
  expect(health.data.counts.products).toBeGreaterThan(0)
  await page.goto('/shop/')
  const first = page.locator('a[href^="/products/"]').first()
  await first.click()
  const form = page.locator('form[action="/checkout/"]')
  await expect(form).toBeVisible()
  const sku = await form.locator('input[name=sku]').inputValue()
  expect(sku).not.toBe('')
  expect(await form.locator('input[name=price], input[name=amount]').count()).toBe(0)
  // No astro:assets runtime image URLs on server-rendered pages.
  expect(await page.locator('img[src*="/_image?"]').count()).toBe(0)
})

test('checkout refuses an unknown SKU and reports missing fields per field', async ({ request }) => {
  const res = await request.post('/api/checkout', {
    headers: { ...browser, 'content-type': 'application/json' },
    data: { items: [{ sku: 'DOES-NOT-EXIST', quantity: 1 }], email: 'nope', shipping_address: { country: 'US' }, shipping_option: 'us-standard' },
  })
  expect(res.status()).toBe(422)
  const body = await res.json()
  expect(body.ok).toBe(false)
  expect(body.error.details['items.DOES-NOT-EXIST']).toContain('not a product')
  expect(body.error.details.email).toBeTruthy()
  expect(body.error.details['shipping_address.line1']).toBeTruthy()
})

test('an order goes cart → checkout → pending → paid → shipped through the Store API', async ({ page, request }) => {
  const products = (await (await request.get('/api/skuio/v1/orders?limit=1', { headers: api })).json()) as unknown
  expect(products).toBeTruthy()

  await page.goto('/shop/')
  await page.locator('a[href^="/products/"]').first().click()
  const sku = await page.locator('form[action="/checkout/"] input[name=sku]').inputValue()
  await page.locator('form[action="/checkout/"] button[type=submit]').click()
  await expect(page).toHaveURL(/\/checkout\/\?sku=/)

  await page.fill('#email', 'e2e@example.com')
  await page.fill('#name', 'E2E Buyer')
  await page.fill('#phone', '+1 555 0100')
  await page.fill('#ship_line1', '1 Test Street')
  await page.fill('#ship_city', 'Austin')
  await page.selectOption('#ship_country', 'US')
  // A US address asks for a state from a list and a ZIP code.
  await expect(page.locator('label[for=ship_postal_code]')).toHaveText('ZIP code')
  await page.selectOption('#ship_state', 'TX')
  await page.fill('#ship_postal_code', '78701')
  await page.locator('[data-checkout-form] button[type=submit]').click()

  // manual adapter: the order is placed and waits for payment.
  await expect(page).toHaveURL(/\/checkout\/pending\/\?order=ord_/)
  await expect(page.locator('[data-order-status]')).toHaveAttribute('data-order-status', 'pending_payment')
  const orderId = new URL(page.url()).searchParams.get('order')!

  const fetched = await (await request.get(`/api/skuio/v1/orders/${orderId}`, { headers: api })).json()
  expect(fetched.data.status).toBe('pending_payment')
  expect(fetched.data.lines[0].sku).toBe(sku)
  expect(fetched.data.customer.email).toBe('e2e@example.com')
  expect(fetched.data.shipping_method.code).toBe('us-standard')

  const paid = await request.patch(`/api/skuio/v1/orders/${orderId}`, { headers: api, data: { external_reference: 'SO-E2E', payment: { status: 'paid', provider: 'manual', reference: 'e2e' } } })
  expect(paid.status()).toBe(200)
  expect((await paid.json()).data.status).toBe('paid')

  const shipped = await request.post(`/api/skuio/v1/orders/${orderId}/fulfillments`, {
    headers: api,
    data: { external_id: 'sof-e2e', carrier: 'UPS', tracking_number: '1Z-E2E', tracking_url: 'https://www.ups.com/track?tracknum=1Z-E2E', lines: [{ sku, quantity: 1 }] },
  })
  expect(shipped.status()).toBe(201)
  expect((await request.post(`/api/skuio/v1/orders/${orderId}/fulfillments`, { headers: api, data: { external_id: 'sof-e2e', lines: [{ sku, quantity: 1 }] } })).status()).toBe(200)

  await page.goto(page.url()) // pending page now redirects to the confirmation
  await expect(page).toHaveURL(/\/checkout\/success\//)
  await expect(page.locator('[data-order-status]')).toHaveAttribute('data-order-status', 'fulfilled')

  // Guest lookup sees the tracking number.
  const lookup = await (await request.post('/api/order-lookup', { headers: browser, form: { email: 'e2e@example.com', reference: fetched.data.number } })).json()
  expect(lookup.order.tracking.number).toBe('1Z-E2E')
})

test('a discount code is previewed, carried by a ?code= link, priced into the order and refused when invalid', async ({ page, request }) => {
  const sku = (JSON.parse(readFileSync(new URL('../src/data/products.json', import.meta.url), 'utf8')) as { sku: string; available?: boolean }[]).find((p) => p.available !== false)!.sku

  const preview = await request.get('/api/discount?code=welcome10')
  expect(preview.status()).toBe(200)
  expect((await preview.json()).discount).toEqual({ code: 'WELCOME10', label: '10% off', percentOff: 10, amountOff: null })
  const previewBody = JSON.stringify(await preview.json())
  expect(previewBody).not.toContain('demo-partner')
  expect((await request.get('/api/discount?code=NOPE')).status()).toBe(404)

  // A partner link keeps the code applied through to checkout.
  await page.goto('/?code=welcome10')
  expect((await page.context().cookies()).find((c) => c.name === 'sf_discount')?.value).toBe('WELCOME10')
  await page.goto(`/checkout/?sku=${encodeURIComponent(sku)}&quantity=1`)
  await expect(page.locator('[data-discount-code]')).toHaveText('WELCOME10')
  await expect(page.locator('[data-summary-discount-row]')).toBeVisible()

  const order = (code: string) =>
    request.post('/api/checkout', {
      headers: { ...browser, 'content-type': 'application/json' },
      data: {
        items: [{ sku, quantity: 1 }],
        email: 'e2e-discount@example.com',
        name: 'Ada Lovelace',
        phone: '+1 555 0100',
        shipping_address: { name: 'Ada Lovelace', line1: '1 Analytical Way', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
        shipping_option: 'us-standard',
        discount_code: code,
      },
    })
  const bad = await order('NOT-A-CODE')
  expect(bad.status()).toBe(422)
  expect((await bad.json()).error.details.discount_code).toBeTruthy()

  const good = await order('welcome10')
  expect(good.status()).toBe(200)
  const placed = await (await request.get(`/api/skuio/v1/orders/${(await good.json()).order.id}`, { headers: api })).json()
  expect(placed.data.discount_code).toBe('WELCOME10')
  expect(placed.data.discount.amount).toBe(Math.round(placed.data.subtotal.amount * 0.1))
  expect(placed.data.total.amount).toBe(placed.data.subtotal.amount - placed.data.discount.amount + placed.data.shipping.amount)

  // A partner report needs its key.
  expect((await request.get('/partners/demo-partner/')).status()).toBe(404)
})

test('partner dashboard signs in by emailed link and says nothing about who is a partner', async ({ page, request }) => {
  await page.goto('/partners/')
  await expect(page.getByRole('button', { name: /sign-in link/i })).toBeVisible()

  // Signed out, the dashboard sends you to sign in.
  const dash = await request.get('/partners/dashboard/', { maxRedirects: 0 })
  expect(dash.status()).toBe(303)
  expect(dash.headers().location).toBe('/partners/')

  // Known and unknown addresses get the same answer.
  for (const email of ['partner@example.com', 'nobody@example.com']) {
    const res = await request.post('/api/partners/session', { form: { email }, headers: { origin: new URL(page.url()).origin }, maxRedirects: 0 })
    expect(res.status()).toBe(303)
    expect(res.headers().location).toBe('/partners/?sent=1')
  }

  // A bad or reused link explains itself instead of erroring.
  const bad = await request.get('/partners/verify/?token=not-a-token', { maxRedirects: 0 })
  expect(bad.headers().location).toBe('/partners/?expired=1')
})

test('owner pages for orders and partners need a signed-in owner', async ({ request }) => {
  for (const path of ['/admin/orders/', '/admin/partners/']) {
    const res = await request.get(path, { maxRedirects: 0 })
    expect([302, 303], path).toContain(res.status())
    expect(res.headers().location, path).toContain('/admin/sign-in')
  }
})

test('the Store API refuses a missing or wrong key', async ({ request }) => {
  expect((await request.get('/api/skuio/v1/health')).status()).toBe(401)
  expect((await request.get('/api/skuio/v1/health', { headers: { Authorization: 'Bearer nope' } })).status()).toBe(401)
})

test('every order records the channel that brought the buyer, first and last touch', async ({ page, request }) => {
  await page.goto('/?utm_source=newsletter&utm_medium=email&utm_campaign=spring')
  await page.goto('/?fbclid=e2e-click') // a later ad click becomes the last touch; the first never moves
  await page.goto('/shop/')
  await page.locator('a[href^="/products/"]').first().click()
  const sku = await page.locator('form[action="/checkout/"] input[name=sku]').inputValue()

  // page.request shares the browser's cookies, as the checkout form would.
  const res = await page.request.post('/api/checkout', {
    headers: { ...browser, 'content-type': 'application/json' },
    data: {
      items: [{ sku, quantity: 1 }],
      email: 'e2e-attribution@example.com',
      name: 'Grace Hopper',
      phone: '+1 555 0100',
      shipping_address: { name: 'Grace Hopper', line1: '1 Compiler Way', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      shipping_option: 'us-standard',
    },
  })
  expect(res.status()).toBe(200)
  const placed = await (await request.get(`/api/skuio/v1/orders/${(await res.json()).order.id}`, { headers: api })).json()
  expect(placed.data.metadata.src_first).toBe('newsletter / email / spring')
  expect(placed.data.metadata.src_last).toBe('meta / paid')
  expect(placed.data.metadata.src_last_click).toBe('fbclid')
})
