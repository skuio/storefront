import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Request for quote, end to end, as a guest who never makes an account: add to quote → send the request →
 * the operations system prices it through the Store API → the buyer accepts → the order arrives on GET /orders.
 */
function devVar(name: string): string | undefined {
  const file = new URL('../.dev.vars', import.meta.url)
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || undefined
}
const API_KEY = devVar('STORE_API_KEY') ?? process.env.STORE_API_KEY ?? 'e2e-store-api-key-e2e-store-api-key'
const api = { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }

test('a guest requests a quote, the operations system prices it, and accepting places the order', async ({ page, request }) => {
  await page.goto('/shop/')
  await page.locator('a[href^="/products/"]').first().click()
  await page.locator('[data-add-to-quote]').click()
  await expect(page.locator('[data-quote-added]')).toBeVisible()
  const sku = (await page.locator('[data-add-to-quote]').getAttribute('data-sku'))!

  await page.goto('/quote/')
  await expect(page.locator(`[data-quote-lines] [data-sku="${sku}"]`)).toBeVisible()
  await page.locator(`[data-quote-lines] [data-sku="${sku}"] [data-qty]`).fill('25')
  await page.locator(`[data-quote-lines] [data-sku="${sku}"] [data-qty]`).dispatchEvent('change')
  const email = `rfq-${Date.now()}@agency.example`
  await page.fill('#q-name', 'Sam Procurement')
  await page.fill('#q-email', email)
  await page.fill('#q-company', 'Field Office 7')
  await page.fill('#q-message', 'Need these before the end of the fiscal year.')
  await page.locator('[data-quote-submit]').click()

  await expect(page).toHaveURL(/\/quotes\/quo_[a-z0-9]+\/\?key=/)
  await expect(page.locator('[data-quote-status]')).toHaveAttribute('data-quote-status', 'requested')
  await expect(page.getByText('Request sent.')).toBeVisible()
  const quoteId = new URL(page.url()).pathname.split('/')[2]!
  const quoteUrl = page.url().replace(/&sent=1$/, '')

  // The operations system sees the request — 25 units, the guest's details, no price yet.
  const listed = await (await request.get(`/api/store/v1/quotes/${quoteId}`, { headers: api })).json()
  expect(listed.data).toMatchObject({ status: 'requested', customer: { email, name: 'Sam Procurement' }, company: 'Field Office 7', total: null })
  expect(listed.data.lines).toMatchObject([{ sku, quantity: 25, unit_amount: null }])

  const priced = await request.patch(`/api/store/v1/quotes/${quoteId}`, {
    headers: api,
    data: {
      external_reference: 'QT-E2E',
      offer: { lines: [{ sku, quantity: 25, unit_amount: { amount: 1000, currency: listed.data.currency } }], shipping: { amount: 1500, currency: listed.data.currency }, note: 'Ships in 3 weeks.' },
    },
  })
  expect(priced.status()).toBe(200)

  await page.goto(quoteUrl)
  await expect(page.locator('[data-quote-status]')).toHaveAttribute('data-quote-status', 'quoted')
  await expect(page.getByText('Ships in 3 weeks.')).toBeVisible()
  await page.fill('#a-ship-line1', '1 Federal Plaza')
  await page.fill('#a-ship-city', 'Austin')
  await page.selectOption('#a-ship-country', 'US')
  await page.fill('#a-ship-state', 'TX')
  await page.fill('#a-ship-postal', '78701')
  await page.fill('#a-po', 'PO-E2E-1')
  await page.locator('[data-quote-accept]').click()

  await expect(page.locator('[data-quote-accepted]')).toBeVisible()
  await expect(page.locator('[data-quote-status]')).toHaveAttribute('data-quote-status', 'accepted')

  const accepted = await (await request.get(`/api/store/v1/quotes/${quoteId}`, { headers: api })).json()
  expect(accepted.data.order_id).toMatch(/^ord_/)
  const order = await (await request.get(`/api/store/v1/orders/${accepted.data.order_id}`, { headers: api })).json()
  expect(order.data).toMatchObject({
    status: 'pending_payment',
    payment: { provider: 'manual' },
    subtotal: { amount: 25_000 },
    shipping: { amount: 1500 },
    total: { amount: 26_500 },
    customer: { email },
    metadata: { quote_id: quoteId, quote_external_reference: 'QT-E2E', po_number: 'PO-E2E-1' },
  })
  expect(order.data.lines).toMatchObject([{ sku, quantity: 25, unit_amount: { amount: 1000 } }])
})

test('the quote page is a 404 without its key, and the quote list endpoint needs the API key', async ({ request }) => {
  expect((await request.get('/quotes/quo_doesnotexist/?key=nope')).status()).toBe(404)
  expect((await request.get('/api/store/v1/quotes')).status()).toBe(401)
  expect((await request.get('/api/store/v1/quotes', { headers: api })).status()).toBe(200)
})
