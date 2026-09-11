import { expect, test } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'

/**
 * The guardrail. Change anything you like about this store; keep this green.
 *
 * The Stripe step needs STRIPE_SECRET_KEY (from .env) and is skipped without
 * it, so the structural checks still run on a fresh clone.
 */

const products = JSON.parse(readFileSync(new URL('../src/data/products.json', import.meta.url), 'utf8')) as {
  sku: string
  slug: string
  price: { amount: number }
  available: boolean
}[]
const sample = products.find((p) => p.available)!

function stripeKey(): string | undefined {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY
  const envFile = new URL('../.env', import.meta.url)
  if (!existsSync(envFile)) return undefined
  return readFileSync(envFile, 'utf8').match(/^STRIPE_SECRET_KEY=(.+)$/m)?.[1]?.trim()
}

test('home page lists categories and links into the catalogue', async ({ page, request }) => {
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 15_000 })
  const links = page.locator('a[href^="/collections/"], a[href^="/products/"]')
  expect(await links.count()).toBeGreaterThan(0)

  // Links must resolve, not merely exist: a route file that does not match
  // `routes` in storefront.config.ts produces links to pages that 404.
  const hrefs = [...new Set(await links.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!)))]
  for (const href of hrefs.slice(0, 6)) {
    const res = await request.get(href)
    expect(res.status(), `${href} should resolve`).toBe(200)
  }
})

test('product page has a buy form that carries a SKU and no price', async ({ page }) => {
  await page.goto(`/products/${sample.slug}/`)
  const form = page.locator('form[action="/api/checkout"]')
  await expect(form).toBeVisible()
  await expect(form.locator('input[name=sku]')).toHaveValue(sample.sku)
  expect(await form.locator('input[name=price], input[name=amount]').count()).toBe(0)
})

// Astro's CSRF protection (security.checkOrigin) 403s a POST whose Origin does not
// match the site — correct for production, so the tests send it like a browser would.
const browserHeaders = { Origin: 'http://localhost:4321' }

test('checkout endpoint refuses an unknown SKU', async ({ request }) => {
  const res = await request.post('/api/checkout', { form: { sku: 'DOES-NOT-EXIST', quantity: '1' }, headers: browserHeaders, maxRedirects: 0 })
  expect(res.status()).toBe(400)
})

test('checkout creates a Stripe session priced from the catalogue', async ({ request }) => {
  const key = stripeKey()
  test.skip(!key, 'STRIPE_SECRET_KEY not set — skipping live Stripe check')

  const res = await request.post('/api/checkout', { form: { sku: sample.sku, quantity: '2' }, headers: browserHeaders, maxRedirects: 0 })
  expect(res.status()).toBe(303)
  const location = res.headers()['location']!
  expect(location).toContain('checkout.stripe.com')

  const sessionId = location.match(/cs_(?:test|live)_[A-Za-z0-9]+/)![0]
  interface SessionShape {
    mode: string
    amount_subtotal: number
    line_items: { data: { quantity: number; price: { unit_amount: number } }[] }
  }
  const stripe = (await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
  }).then((r) => r.json())) as SessionShape

  expect(stripe.mode).toBe('payment')
  expect(stripe.line_items.data[0]!.quantity).toBe(2)
  expect(stripe.line_items.data[0]!.price.unit_amount).toBe(sample.price.amount)
  expect(stripe.amount_subtotal).toBe(sample.price.amount * 2)
})

test('server-rendered success page references no runtime image transforms', async ({ request }) => {
  // /checkout/success/ is the one on-demand HTML route. With the compile image
  // service, an <Image> anywhere in its layout emits /_image?… which cannot be
  // served at runtime (522 in production). Layout images must be plain <img>.
  const res = await request.get('/checkout/success/')
  expect(res.status()).toBe(200)
  expect(await res.text()).not.toContain('/_image?')
})

test('cart page renders and checks out several lines in one session', async ({ page, request }) => {
  await page.goto('/cart/', { waitUntil: 'load' })
  await expect(page.locator('main h1').first()).toHaveText(/cart/i)

  const key = stripeKey()
  test.skip(!key, 'STRIPE_SECRET_KEY not set — skipping live Stripe check')

  const [a, b] = products.filter((p) => p.available).slice(0, 2)
  const items = JSON.stringify([{ sku: a!.sku, quantity: 1 }, { sku: b!.sku, quantity: 3 }])
  const res = await request.post('/api/checkout', { form: { items }, headers: browserHeaders, maxRedirects: 0 })
  expect(res.status()).toBe(303)
  const sessionId = res.headers()['location']!.match(/cs_(?:test|live)_[A-Za-z0-9]+/)![0]

  interface SessionShape { amount_subtotal: number; line_items: { data: { quantity: number; price: { unit_amount: number; product: { metadata: { sku: string } } } }[] } }
  const s = (await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items&expand[]=line_items.data.price.product`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
  }).then((r) => r.json())) as SessionShape

  const bySku = Object.fromEntries(s.line_items.data.map((l) => [l.price.product.metadata.sku, l]))
  expect(Object.keys(bySku).sort()).toEqual([a!.sku, b!.sku].sort())
  expect(bySku[a!.sku]!.quantity).toBe(1)
  expect(bySku[b!.sku]!.quantity).toBe(3)
  expect(bySku[b!.sku]!.price.unit_amount).toBe(b!.price.amount)
  expect(s.amount_subtotal).toBe(a!.price.amount + b!.price.amount * 3)
})

test('checkout refuses a cart containing an unknown SKU', async ({ request }) => {
  const items = JSON.stringify([{ sku: sample.sku, quantity: 1 }, { sku: 'GONE-FROM-CATALOGUE', quantity: 1 }])
  const res = await request.post('/api/checkout', { form: { items }, headers: browserHeaders, maxRedirects: 0 })
  expect(res.status()).toBe(400)
})

test('checkout opens one shipping region at a time', async ({ request }) => {
  const key = stripeKey()
  test.skip(!key, 'STRIPE_SECRET_KEY not set — skipping live Stripe check')
  const auth = { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }
  interface S { shipping_address_collection: { allowed_countries: string[] }; shipping_options: { shipping_rate: string }[]; metadata: Record<string, string> }
  const open = async (region?: string) => {
    const res = await request.post('/api/checkout', { form: { sku: sample.sku, quantity: '1', ...(region ? { region } : {}) }, headers: browserHeaders, maxRedirects: 0 })
    expect(res.status()).toBe(303)
    const id = res.headers()['location']!.match(/cs_(?:test|live)_[A-Za-z0-9]+/)![0]
    return (await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, { headers: auth }).then((r) => r.json())) as S
  }

  const domestic = await open()
  expect(domestic.shipping_address_collection.allowed_countries).toEqual(['US'])
  expect(domestic.shipping_options).toHaveLength(1)
  expect(domestic.metadata.region).toBe('domestic')

  const intl = await open('international')
  expect(intl.shipping_address_collection.allowed_countries).not.toContain('US')
  expect(intl.shipping_address_collection.allowed_countries.length).toBeGreaterThan(0)
  expect(intl.shipping_options).toHaveLength(1)
  expect(intl.metadata.region).toBe('international')
})

test('account: protected pages bounce without a session; a bad link is refused', async ({ request }) => {
  const orders = await request.get('/account/orders/', { maxRedirects: 0 })
  expect(orders.status()).toBe(303)
  expect(orders.headers()['location']).toBe('/account/')

  const verify = await request.get('/account/verify/?token=not-a-real-token', { maxRedirects: 0 })
  expect(verify.status()).toBe(303)
  expect(verify.headers()['location']).toBe('/account/?error=link')
})

test('account: sign in by link, see orders with tracking, reorder into the cart, sign out', async ({ page }) => {
  // The dev server runs with a mock customers capability (src/lib/mock-customers.ts).
  await page.goto('/account/', { waitUntil: 'load' })
  await page.fill('#email', 'demo@example.com')
  await page.click('form[action="/api/account/session"] button[type=submit]')
  await expect(page).toHaveURL(/\/account\/\?sent=1/)
  await expect(page.locator('[role=status]')).toContainText('Check your email')

  // Follow the "emailed" link. The cookie it sets must be httpOnly.
  await page.goto('/account/verify/?token=mock:demo@example.com')
  await expect(page).toHaveURL(/\/account\/orders\//)
  const cookie = (await page.context().cookies()).find((c) => c.name === 'skuio_customer_session')
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite).toBe('Lax')

  await expect(page.locator('main h1')).toContainText("Demo's orders")
  await expect(page.getByText('Order 1002')).toBeVisible()
  await expect(page.getByRole('link', { name: '1Z999AA10123456784' })).toHaveAttribute('href', /ups\.com/)
  await expect(page.getByText('Being prepared')).toBeVisible()

  // Reorder puts the lines in the cart and goes there.
  await page.locator('[data-reorder]').first().click()
  await expect(page).toHaveURL(/\/cart\//)
  await expect(page.locator('[data-cart-lines] li')).toHaveCount(1)
  await expect(page.locator('[data-cart-lines]')).toContainText('Ridge Daypack 22L')

  // Signed-in visit to /account/ goes straight to orders; sign-out ends it.
  await page.goto('/account/')
  await expect(page).toHaveURL(/\/account\/orders\//)
  await page.click('form[action="/api/account/sign-out"] button')
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/account/orders/')
  await expect(page).toHaveURL(/\/account\/$/)
})
