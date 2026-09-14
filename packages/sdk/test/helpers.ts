import { defineStorefront, flatRate, freeShipping } from '../src'
import type { MailAdapter, MailMessage } from '../src/mail'
import { createStore, type Store } from '../src/store'
import { sqliteDatabase, type TestDatabase } from './sqlite'

export const config = defineStorefront({
  name: 'Test Store',
  url: 'https://store.test',
  currency: 'usd',
  shipping: [
    freeShipping('us', 'Free shipping (United States)', { estimate: { min: 3, max: 7 }, countries: ['US'] }),
    flatRate('intl', 'International shipping', { amount: 4000, currency: 'usd' }, { estimate: { min: 7, max: 21 } }),
  ],
  shipToCountries: ['US', 'CA', 'GB'],
  contact: { phone: '555-0100', email: 'help@store.test' },
})

export interface FakeMail extends MailAdapter {
  sent: MailMessage[]
  failNext: boolean
}

export function fakeMail(): FakeMail {
  const adapter: FakeMail = {
    id: 'fake',
    sent: [],
    failNext: false,
    async send(message) {
      if (adapter.failNext) {
        adapter.failNext = false
        throw new Error('mail down')
      }
      adapter.sent.push(message)
    },
  }
  return adapter
}

export interface TestClock {
  now: Date
  tick(ms: number): void
}

export function testClock(start = '2026-09-13T12:00:00.000Z'): TestClock {
  const clock: TestClock = {
    now: new Date(start),
    tick(ms) {
      clock.now = new Date(clock.now.getTime() + ms)
    },
  }
  return clock
}

export interface Rig {
  db: TestDatabase
  store: Store
  mail: FakeMail
  clock: TestClock
  env: Record<string, string | undefined>
}

export function rig(env: Record<string, string | undefined> = {}): Rig {
  const db = sqliteDatabase()
  const mail = fakeMail()
  const clock = testClock()
  const store = createStore({
    db,
    config,
    env,
    mail,
    clock: () => {
      // Every call advances a millisecond so updated_at keeps strict order.
      clock.tick(1)
      return clock.now
    },
    catalogCacheTtlMs: 0,
    log: () => {},
  })
  return { db, store, mail, clock, env }
}

export const categories = [
  { id: 'toyota', name: 'Toyota', parent_id: null, position: 1 },
  { id: 'tacoma', name: 'Tacoma', parent_id: 'toyota', position: 1 },
  { id: 'supra', name: 'Supra', parent_id: 'toyota', position: 2 },
  { id: 'honda', name: 'Honda', parent_id: null, position: 2 },
  { id: 'civic', name: 'Civic', parent_id: 'honda', position: 1 },
  { id: 'empty', name: 'Empty', parent_id: null, position: 3 },
]

export const products = [
  {
    sku: 'VDCTOYTAC9504',
    name: 'Toyota Tacoma 1995-2004 Vertical Lambo Doors',
    price: { amount: 109900, currency: 'USD' },
    compare_at_price: { amount: 129500, currency: 'USD' },
    images: [{ url: 'https://cdn.test/tacoma.jpg', alt: 'Tacoma' }],
    category_ids: ['tacoma'],
    attributes: { Fits: '1995-2004' },
    active: true,
  },
  {
    sku: 'VDCTOYSUP9302',
    name: 'Toyota Supra 1993-2002 Vertical Lambo Doors',
    price: { amount: 119900, currency: 'USD' },
    images: [],
    category_ids: ['supra'],
    active: true,
  },
  {
    sku: 'VDCHCIV0611',
    name: 'Honda Civic 2006-2011 Vertical Lambo Doors',
    price: { amount: 99500, currency: 'USD' },
    images: [{ url: 'civic.jpg' }],
    category_ids: ['civic'],
    active: true,
  },
]

export async function seed(store: Store): Promise<void> {
  await store.catalog.upsertCategories(categories)
  await store.catalog.upsertProducts(products)
  await store.inventory.set([{ sku: 'VDCHCIV0611', available: 0 }])
}

export const usAddress = { name: 'Ada Lovelace', line1: '1 Analytical Way', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' }

export async function placeOrder(store: Store, overrides: Partial<Parameters<Store['checkout']['createOrder']>[0]> = {}) {
  return store.checkout.createOrder({
    items: [{ sku: 'VDCTOYTAC9504', quantity: 1 }],
    email: 'Ada@Example.com',
    name: 'Ada Lovelace',
    phone: '+1 555 0100',
    shippingAddress: usAddress,
    shippingOptionId: 'us',
    ...overrides,
  })
}
