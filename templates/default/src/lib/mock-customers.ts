import type { CatalogProvider, CustomerOrder, CustomerProvider } from '@skuio/storefront'

/**
 * A fake `customers` capability for local development and the e2e run,
 * enabled only by SKUIO_MOCK_CUSTOMERS=1 in dev. It lets the portal pages be
 * exercised end to end before the SKU.io endpoints exist. The "emailed" token
 * is simply `mock:<email>`; nothing is sent anywhere.
 */
const orders: CustomerOrder[] = [
  {
    id: 'so_demo_2', reference: '1002', status: 'completed', fulfillmentStatus: 'fulfilled',
    subtotal: { amount: 12900, currency: 'usd' }, shipping: { amount: 0, currency: 'usd' }, total: { amount: 12900, currency: 'usd' },
    lines: [{ sku: 'NW-BAG-001', name: 'Ridge Daypack 22L', quantity: 1, unitPrice: { amount: 12900, currency: 'usd' }, total: { amount: 12900, currency: 'usd' } }],
    shipments: [{ carrier: 'UPS', trackingNumber: '1Z999AA10123456784', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784', shippedAt: '2026-09-02T17:00:00Z' }],
    channel: 'Northwind Outfitters', createdAt: '2026-08-29T15:12:00Z',
  },
  {
    id: 'so_demo_1', reference: '1001', status: 'completed', fulfillmentStatus: 'unfulfilled',
    subtotal: { amount: 6400, currency: 'usd' }, shipping: { amount: 0, currency: 'usd' }, total: { amount: 6400, currency: 'usd' },
    lines: [{ sku: 'NW-TEE-001', name: 'Trailhead Tee — Moss', quantity: 2, unitPrice: { amount: 3200, currency: 'usd' }, total: { amount: 6400, currency: 'usd' } }],
    shipments: [], channel: 'Northwind Outfitters', createdAt: '2026-09-10T09:00:00Z',
  },
]

const sessions = new Map<string, string>() // sessionToken -> email

export const mockCustomers: CustomerProvider = {
  async requestSession(email) {
    console.log(`[mock-customers] would email ${email} a link with token mock:${email}`)
  },
  async exchange(token) {
    if (!token.startsWith('mock:')) throw Object.assign(new Error('Link expired'), { status: 401, code: 'invalid_token' })
    const email = token.slice(5)
    const sessionToken = `cst_mock_${Math.random().toString(36).slice(2)}`
    sessions.set(sessionToken, email)
    return { sessionToken, expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(), customer: { id: 'cus_mock', email, name: 'Demo Customer' } }
  },
  async me(sessionToken) {
    const email = sessions.get(sessionToken)
    if (!email) throw Object.assign(new Error('Session expired'), { status: 401 })
    return { id: 'cus_mock', email, name: 'Demo Customer' }
  },
  async orders(sessionToken) {
    if (!sessions.has(sessionToken)) throw Object.assign(new Error('Session expired'), { status: 401 })
    return orders
  },
  async revoke(sessionToken) {
    sessions.delete(sessionToken)
  },
}

export function withMockCustomers(provider: CatalogProvider): CatalogProvider {
  return { ...provider, customers: mockCustomers }
}
