import { describe, expect, it } from 'vitest'
import { StoreError } from '../src/store'
import { serializeOrder } from '../src/api/serialize'
import { config, placeOrder, products, rig, seed, usAddress } from './helpers'

describe('catalog service', () => {
  it('upserts categories and products and builds the snapshot', async () => {
    const { store } = rig()
    await seed(store)
    const catalog = await store.catalog.load()
    expect(catalog.products.map((p) => p.sku).sort()).toEqual(['VDCHCIV0611', 'VDCTOYSUP9302', 'VDCTOYTAC9504'])
    const tacoma = catalog.product('VDCTOYTAC9504')!
    expect(tacoma.id).toBe('VDCTOYTAC9504')
    expect(tacoma.slug).toBe('toyota-tacoma-1995-2004-vertical-lambo-doors')
    expect(tacoma.price).toEqual({ amount: 109900, currency: 'usd' })
    expect(tacoma.compareAtPrice).toEqual({ amount: 129500, currency: 'usd' })
    expect(tacoma.images).toEqual([{ src: 'https://cdn.test/tacoma.jpg', alt: 'Tacoma' }])
    expect(tacoma.attributes).toEqual({ Fits: '1995-2004' })
    expect(tacoma.available).toBe(true)
    expect(tacoma.availability).toBeUndefined() // untracked
    expect(catalog.tree().map((n) => n.slug)).toEqual(['toyota', 'honda', 'empty'])
    expect(catalog.category('toyota')!.productCount).toBe(2)
    expect(catalog.breadcrumbs(tacoma).map((c) => c.slug)).toEqual(['toyota', 'tacoma'])
  })

  it('keeps an existing slug on re-push and never steals another product\'s slug', async () => {
    const { store } = rig()
    await seed(store)
    await store.catalog.upsertProducts([{ ...products[0]!, name: 'Renamed Tacoma Kit' }])
    let catalog = await store.catalog.load()
    expect(catalog.product('VDCTOYTAC9504')!.slug).toBe('toyota-tacoma-1995-2004-vertical-lambo-doors')
    expect(catalog.product('VDCTOYTAC9504')!.name).toBe('Renamed Tacoma Kit')

    await store.catalog.upsertProducts([{ sku: 'NEW-1', name: 'Toyota Tacoma 1995-2004 Vertical Lambo Doors', price: { amount: 100, currency: 'USD' } }])
    catalog = await store.catalog.load()
    expect(catalog.product('NEW-1')!.slug).toBe('toyota-tacoma-1995-2004-vertical-lambo-doors-new-1')

    await store.catalog.upsertProducts([{ sku: 'NEW-1', name: 'x', slug: 'chosen-slug', price: { amount: 100, currency: 'USD' } }])
    catalog = await store.catalog.load()
    expect(catalog.product('NEW-1')!.slug).toBe('chosen-slug')
  })

  it('rejects a product priced in another currency', async () => {
    const { store } = rig()
    await expect(store.catalog.upsertProducts([{ sku: 'X', name: 'X', price: { amount: 1, currency: 'EUR' } }])).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('deactivates a product without deleting it', async () => {
    const { store } = rig()
    await seed(store)
    expect(await store.catalog.deactivateProduct('VDCTOYSUP9302')).toBe(true)
    expect(await store.catalog.deactivateProduct('nope')).toBe(false)
    const catalog = await store.catalog.load()
    expect(catalog.product('VDCTOYSUP9302')).toBeUndefined()
    expect((await store.catalog.counts()).products).toBe(2)
    expect(await store.catalog.existingSkus(['VDCTOYSUP9302', 'nope'])).toEqual(new Set(['VDCTOYSUP9302']))
  })

  it('caches the snapshot per database until a write invalidates it', async () => {
    const { db, mail, clock } = rig()
    const { createStore } = await import('../src/store')
    const { config } = await import('./helpers')
    const store = createStore({ db, config, mail, clock: () => clock.now, catalogCacheTtlMs: 60_000, log: () => {} })
    await seed(store)
    const a = await store.catalog.load()
    const b = await store.catalog.load()
    expect(a).toBe(b)
    await store.inventory.set([{ sku: 'VDCTOYTAC9504', available: 1 }])
    const c = await store.catalog.load()
    expect(c).not.toBe(a)
    expect(c.product('VDCTOYTAC9504')!.availability?.status).toBe('low_stock')
  })
})

describe('category upsert is migration-safe', () => {
  it('adopts a same-parent category by slug: re-keys it and moves its products and children', async () => {
    const { store } = rig()
    await seed(store)
    // SKU.io pushes the same tree with its own ids over the seeded one.
    await store.catalog.upsertCategories([
      { id: '100', name: 'Toyota', parent_id: null, position: 1 },
      { id: '101', name: 'Tacoma', parent_id: '100', position: 1 },
    ])
    const catalog = await store.catalog.load()
    expect(catalog.category('toyota')).toBeUndefined()
    expect(catalog.category('tacoma')).toBeUndefined()
    expect(catalog.category('100')).toMatchObject({ slug: 'toyota', parentId: null })
    expect(catalog.category('101')).toMatchObject({ slug: 'tacoma', parentId: '100' })
    expect(catalog.category('supra')).toMatchObject({ parentId: '100' }) // sibling not in the push follows the adopted parent
    expect(catalog.product('VDCTOYTAC9504')!.categoryIds).toEqual(['101'])
    expect(catalog.breadcrumbs(catalog.product('VDCTOYTAC9504')!).map((c) => [c.id, c.slug])).toEqual([['100', 'toyota'], ['101', 'tacoma']])
    expect((await store.catalog.counts()).categories).toBe(6)
    expect(catalog.categoryByPath(['toyota', 'tacoma'])!.productCount).toBe(1)
  })

  it('suffixes when the slug is owned by a category under a different parent, or claimed twice in a batch', async () => {
    const { store } = rig()
    await seed(store)
    await store.catalog.upsertCategories([
      { id: '200', name: 'Civic', parent_id: 'toyota' }, // 'civic' lives under honda
      { id: '201', name: 'Supra', parent_id: 'toyota' }, // adopted: same parent
      { id: '202', name: 'Tacoma', parent_id: 'toyota' }, // adopts the seeded tacoma…
      { id: '203', name: 'Tacoma', parent_id: 'toyota' }, // …so this one is a duplicate claim in the batch
    ])
    const catalog = await store.catalog.load()
    expect(catalog.category('200')!.slug).toBe('civic-200')
    expect(catalog.category('civic')!.slug).toBe('civic')
    expect(catalog.category('201')!.slug).toBe('supra')
    expect(catalog.category('supra')).toBeUndefined()
    expect(catalog.category('202')!.slug).toBe('tacoma')
    expect(catalog.category('203')!.slug).toBe('tacoma-203')
  })

  it('is idempotent on a second push and heals a suffixed duplicate on re-push', async () => {
    const { store } = rig()
    await seed(store)
    const push = [
      { id: '100', name: 'Toyota', parent_id: null },
      { id: '101', name: 'Tacoma', parent_id: '100' },
      { id: '102', name: 'Supra', parent_id: '100' },
    ]
    await store.catalog.upsertCategories(push)
    const before = (await store.catalog.load()).allCategories().map((c) => [c.id, c.slug, c.parentId]).sort()
    await store.catalog.upsertCategories(push)
    const after = (await store.catalog.load()).allCategories().map((c) => [c.id, c.slug, c.parentId]).sort()
    expect(after).toEqual(before)
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.categoryIds).toEqual(['101'])

    // A leftover suffixed duplicate from before adoption existed: the natural slug is owned by a
    // seeded same-parent row that still has a product. Re-pushing the suffixed id merges them.
    await store.db.prepare(`INSERT INTO categories (id, name, slug, parent_id, position, created_at, updated_at) VALUES ('S', 'Tacoma', 'tacoma-old', '100', 0, 'x', 'x')`).run()
    await store.db.prepare(`UPDATE categories SET slug = 'tacoma-101' WHERE id = '101'`).run()
    await store.db.prepare(`UPDATE categories SET slug = 'tacoma' WHERE id = 'S'`).run()
    await store.db.prepare(`UPDATE product_categories SET category_id = 'S' WHERE category_id = '101'`).run()
    store.catalog.invalidate()
    expect((await store.catalog.load()).category('101')!.slug).toBe('tacoma-101')
    await store.catalog.upsertCategories([{ id: '101', name: 'Tacoma', parent_id: '100' }])
    const healed = await store.catalog.load()
    expect(healed.category('101')!.slug).toBe('tacoma')
    expect(healed.category('S')).toBeUndefined()
    expect(healed.product('VDCTOYTAC9504')!.categoryIds).toEqual(['101'])
  })
})

describe('inventory service', () => {
  it('derives availability from quantities and thresholds', async () => {
    const { store } = rig()
    await seed(store)
    const result = await store.inventory.set([
      { sku: 'VDCTOYTAC9504', available: 12 },
      { sku: 'VDCTOYSUP9302', available: 2 },
      { sku: 'VDCHCIV0611', available: 0, allow_backorder: true },
      { sku: 'GHOST', available: 5 },
    ])
    expect(result).toEqual({ updated: 3, unknown_skus: ['GHOST'] })
    const catalog = await store.catalog.load()
    expect(catalog.product('VDCTOYTAC9504')!.availability).toMatchObject({ status: 'in_stock', quantity: 12 })
    expect(catalog.product('VDCTOYSUP9302')!.availability).toMatchObject({ status: 'low_stock', quantity: 2 })
    expect(catalog.product('VDCHCIV0611')!.availability).toMatchObject({ status: 'backorder', quantity: 0 })
    expect(catalog.product('VDCHCIV0611')!.available).toBe(true)
    await store.inventory.set([{ sku: 'VDCHCIV0611', available: 0 }])
    expect((await store.catalog.load()).product('VDCHCIV0611')!.available).toBe(false)
  })
})

describe('checkout', () => {
  it('prices from the catalogue, merges duplicate lines and numbers orders from 1001', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store, {
      items: [
        { sku: 'VDCTOYTAC9504', quantity: 1 },
        { sku: 'VDCTOYTAC9504', quantity: 2 },
        { sku: 'VDCTOYSUP9302', quantity: 99 },
      ],
      notes: '  Leave at the gate ',
    })
    expect(order.number).toBe('1001')
    expect(order.status).toBe('pending_payment')
    expect(order.payment.status).toBe('unpaid')
    expect(order.lines.map((l) => [l.sku, l.quantity, l.totalAmount.amount])).toEqual([
      ['VDCTOYTAC9504', 3, 329700],
      ['VDCTOYSUP9302', 10, 1199000],
    ])
    expect(order.subtotal.amount).toBe(1528700)
    expect(order.shipping.amount).toBe(0)
    expect(order.total.amount).toBe(1528700)
    expect(order.shippingMethod).toEqual({ code: 'us', name: 'Free shipping (United States)' })
    expect(order.customer.email).toBe('ada@example.com')
    expect(order.shippingAddress).toEqual(usAddress)
    expect(order.notes).toBe('Leave at the gate')
    expect(order.accessKey).toHaveLength(32)
    expect(order.lines[0]!.image).toBe('https://cdn.test/tacoma.jpg')

    const second = await placeOrder(store)
    expect(second.number).toBe('1002')
    expect(second.customer.id).toBe(order.customer.id)
    expect((await store.events.list(order.id)).map((e) => e.type)).toEqual(['created'])
  })

  it('starts numbering at orders.numberStart and never goes below it', async () => {
    const { store } = rig({}, { ...config, orders: { numberPrefix: 'VLD', numberStart: 4200 } })
    await seed(store)
    const first = await placeOrder(store)
    const second = await placeOrder(store)
    expect([first.number, second.number]).toEqual(['4200', '4201'])
    // The Store API sends the number the buyer sees, prefix included.
    expect(serializeOrder(first, 'VLD').number).toBe('VLD4200')
    expect(serializeOrder(first).number).toBe('4200')
  })

  it('searches orders for the owner: email, name, number with or without prefix, original number, filters, paging', async () => {
    const { store, db } = rig({}, { ...config, orders: { numberPrefix: 'VLD', numberStart: 4200 } })
    await seed(store)
    const ada = await placeOrder(store)
    const grace = await placeOrder(store, { email: 'grace@example.com', name: 'Grace Hopper' })
    const old = await placeOrder(store, { email: 'old@example.com', name: 'Old Buyer' })
    for (const o of [ada, grace, old]) await store.orders.markPaid(o.id, { provider: 'manual', reference: null, paidAt: null }, { notify: false })
    await db.prepare(`UPDATE orders SET metadata_json = ? WHERE id = ?`).bind(JSON.stringify({ imported_from: 'woocommerce', original_number: 'VLD4111' }), old.id).run()
    const numbers = async (opts: Parameters<typeof store.orders.search>[0]) => (await store.orders.search(opts)).orders.map((o) => o.number)

    expect(await numbers({})).toEqual(['4202', '4201', '4200'])
    expect(await numbers({ query: 'grace@' })).toEqual(['4201'])
    expect(await numbers({ query: 'Lovelace' })).toEqual(['4200'])
    expect(await numbers({ query: 'VLD4201' })).toEqual(['4201'])
    expect(await numbers({ query: '#4200' })).toEqual(['4200'])
    expect(await numbers({ query: 'vld4111' })).toEqual(['4202'])
    expect(await numbers({ source: 'imported' })).toEqual(['4202'])
    expect(await numbers({ source: 'store' })).toEqual(['4201', '4200'])
    expect(await numbers({ status: 'cancelled' })).toEqual([])
    const page = await store.orders.search({ limit: 2, offset: 2 })
    expect([page.total, page.orders.map((o) => o.number)]).toEqual([3, ['4200']])
  })

  it('charges the international rate outside the domestic region and refuses a wrong rate', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store, { shippingAddress: { ...usAddress, country: 'gb', state: undefined, postalCode: 'SW1A 1AA' }, shippingOptionId: 'intl' })
    expect(order.shipping.amount).toBe(4000)
    expect(order.total.amount).toBe(113900)
    expect(order.shippingAddress.country).toBe('GB')
    await expect(placeOrder(store, { shippingAddress: { ...usAddress, country: 'GB' }, shippingOptionId: 'us' })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { shipping_option: expect.stringContaining('not available') },
    })
    await expect(placeOrder(store, { shippingAddress: { ...usAddress, country: 'FR' } })).rejects.toMatchObject({
      details: { 'shipping_address.country': expect.any(String) },
    })
    expect(store.checkout.optionsForCountry('CA').map((o) => o.id)).toEqual(['intl'])
  })

  it('reports every missing field at once and refuses unknown or sold-out SKUs', async () => {
    const { store } = rig()
    await seed(store)
    const err = await placeOrder(store, {
      items: [{ sku: 'VDCHCIV0611', quantity: 1 }, { sku: 'NOPE', quantity: 1 }],
      email: 'not-an-email',
      phone: '',
      shippingAddress: { country: 'US' },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(StoreError)
    expect(err.details).toEqual({
      email: 'must be a valid email address',
      phone: 'is required',
      'shipping_address.name': 'is required',
      'shipping_address.line1': 'is required',
      'shipping_address.city': 'is required',
      'shipping_address.state': 'is required',
      'shipping_address.postal_code': 'is required',
      'items.VDCHCIV0611': 'is sold out',
      'items.NOPE': 'is not a product in this store',
    })
    await expect(placeOrder(store, { items: [] })).rejects.toMatchObject({ details: { items: 'is empty' } })
  })
})

describe('address formats', () => {
  it('asks a US address for a state and ZIP code, and normalises the state', async () => {
    const { checkAddressFormat, addressFormat } = await import('../src/address')
    expect(addressFormat('us')).toMatchObject({ regionLabel: 'State', postalLabel: 'ZIP code', regionRequired: true })
    const a = { country: 'US', state: 'nevada', postalCode: '89101' }
    expect(checkAddressFormat(a)).toEqual({})
    expect(a.state).toBe('NV')
    expect(checkAddressFormat({ country: 'US', state: 'Narnia', postalCode: '8910' })).toEqual({
      'shipping_address.state': 'is not a state',
      'shipping_address.postal_code': "doesn't look like a ZIP code (e.g. 89101)",
    })
    expect(checkAddressFormat({ country: 'CA', state: 'ON', postalCode: 'k1a 0b1' })).toEqual({})
    // Countries without a known format accept any region and no postal code.
    expect(checkAddressFormat({ country: 'SV' })).toEqual({})
  })
})

describe('orders lifecycle', () => {
  it('marks paid once, consumes tracked stock, emails the buyer and the merchant', async () => {
    const { store, mail } = rig({ ORDER_NOTIFICATION_EMAIL: 'owner@store.test' })
    await seed(store)
    await store.inventory.set([{ sku: 'VDCTOYTAC9504', available: 5 }])
    const order = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }] })

    const paid = await store.orders.markPaid(order.id, { provider: 'stripe', reference: 'pi_1', methodLabel: 'Card', amount: { amount: 219800, currency: 'usd' } })
    expect(paid.status).toBe('paid')
    expect(paid.payment).toMatchObject({ status: 'paid', provider: 'stripe', reference: 'pi_1', methodLabel: 'Card' })
    expect(paid.paidAt).toBeTruthy()
    expect(paid.updatedAt > order.updatedAt).toBe(true)
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.availability?.quantity).toBe(3)
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ['ada@example.com', 'Order 1001 confirmed — Test Store'],
      ['owner@store.test', 'New order 1001 — $2,198'],
    ])
    expect(mail.sent[0]!.text).toContain('/checkout/success/?order=' + order.id)
    expect(mail.sent[1]!.replyTo).toBe('ada@example.com')

    // Redelivery: nothing changes, nothing is sent.
    const again = await store.orders.markPaid(order.id, { provider: 'stripe', reference: 'pi_1' })
    expect(again.updatedAt).toBe(paid.updatedAt)
    expect(mail.sent).toHaveLength(2)
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.availability?.quantity).toBe(3)
    expect((await store.events.list(order.id)).map((e) => e.type)).toEqual(['created', 'paid', 'email_sent', 'email_sent'])
    expect(await store.orders.byPaymentReference('stripe', 'pi_1')).toMatchObject({ id: order.id })
  })

  it('applies promotion adjustments reported by the processor', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const paid = await store.orders.markPaid(order.id, {
      provider: 'stripe',
      reference: 'pi_2',
      adjustments: { discount: { amount: 10000, currency: 'usd' }, total: { amount: 99900, currency: 'usd' } },
    })
    expect(paid.discount.amount).toBe(10000)
    expect(paid.total.amount).toBe(99900)
  })

  it('logs but does not throw when the confirmation email fails', async () => {
    const { store, mail } = rig()
    await seed(store)
    const order = await placeOrder(store)
    mail.failNext = true
    const paid = await store.orders.markPaid(order.id, { provider: 'manual', reference: null })
    expect(paid.status).toBe('paid')
    expect((await store.events.list(order.id)).map((e) => e.type)).toContain('email_failed')
  })

  it('cancels, refunds and fails with the right conflicts', async () => {
    const { store } = rig()
    await seed(store)
    await store.inventory.set([{ sku: 'VDCTOYTAC9504', available: 5 }])
    const pending = await placeOrder(store)
    await expect(store.orders.setPaymentStatus(pending.id, { status: 'refunded' })).rejects.toMatchObject({ code: 'conflict' })
    const failed = await store.orders.setPaymentStatus(pending.id, { status: 'failed', provider: 'stripe', reference: 'pi_x' })
    expect(failed.status).toBe('pending_payment')
    expect(failed.payment.status).toBe('failed')

    const paid = await store.orders.markPaid(pending.id, { provider: 'stripe', reference: 'pi_x' })
    expect(paid.payment.status).toBe('paid')
    await expect(store.orders.setPaymentStatus(pending.id, { status: 'failed' })).rejects.toMatchObject({ code: 'conflict' })
    const cancelled = await store.orders.cancel(pending.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).toBeTruthy()
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.availability?.quantity).toBe(5) // restocked
    expect((await store.orders.cancel(pending.id)).updatedAt).toBe(cancelled.updatedAt) // idempotent

    const other = await placeOrder(store)
    const paidOther = await store.orders.markPaid(other.id, { provider: 'manual', reference: null })
    const refunded = await store.orders.setPaymentStatus(paidOther.id, { status: 'refunded', reference: 're_1' })
    expect(refunded.status).toBe('refunded')
    expect(refunded.payment).toMatchObject({ status: 'refunded', provider: 'manual', reference: 're_1' })
  })

  it('records fulfilments idempotently and moves the order through partial to fulfilled', async () => {
    const { store, mail } = rig()
    await seed(store)
    const order = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }, { sku: 'VDCTOYSUP9302', quantity: 1 }] })
    await store.orders.markPaid(order.id, { provider: 'manual', reference: null })
    mail.sent.length = 0

    await expect(store.orders.addFulfillment(order.id, { external_id: 'bad', lines: [{ sku: 'VDCTOYTAC9504', quantity: 3 }, { sku: 'NOPE', quantity: 1 }] })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { 'lines.0.quantity': expect.stringContaining('exceeds'), 'lines.1.sku': 'is not on this order' },
    })

    const first = await store.orders.addFulfillment(order.id, {
      external_id: 'sof_1',
      carrier: 'UPS',
      service: 'Ground',
      tracking_number: '1Z999',
      tracking_url: 'https://ups.test/1Z999',
      shipped_at: '2026-09-13T15:00:00.000Z',
      lines: [{ sku: 'VDCTOYTAC9504', quantity: 2 }],
    })
    expect(first.created).toBe(true)
    expect(first.order.status).toBe('partially_fulfilled')
    expect(first.order.lines.find((l) => l.sku === 'VDCTOYTAC9504')!.fulfilledQuantity).toBe(2)
    expect(first.fulfillment).toMatchObject({ externalId: 'sof_1', carrier: 'UPS', trackingNumber: '1Z999', lines: [{ sku: 'VDCTOYTAC9504', quantity: 2 }] })
    expect(mail.sent.map((m) => m.subject)).toEqual(['Order 1001 has shipped — Test Store'])
    expect(mail.sent[0]!.text).toContain('1Z999')

    const replay = await store.orders.addFulfillment(order.id, { external_id: 'sof_1', lines: [{ sku: 'VDCTOYTAC9504', quantity: 2 }] })
    expect(replay.created).toBe(false)
    expect(replay.fulfillment.id).toBe(first.fulfillment.id)
    expect(mail.sent).toHaveLength(1)

    const last = await store.orders.addFulfillment(order.id, { external_id: 'sof_2', lines: [{ sku: 'VDCTOYSUP9302', quantity: 1 }], notify_customer: false })
    expect(last.order.status).toBe('fulfilled')
    expect(last.order.fulfillments).toHaveLength(2)
    expect(mail.sent).toHaveLength(1)
    await expect(store.orders.cancel(order.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('stamps the external reference once', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const stamped = await store.orders.setExternalReference(order.id, 'SO-0042')
    expect(stamped.externalReference).toBe('SO-0042')
    expect((await store.orders.setExternalReference(order.id, 'SO-0042')).updatedAt).toBe(stamped.updatedAt)
    await expect(store.orders.setExternalReference('ord_missing', 'x')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('pages changed orders by (updated_at, id) with an inclusive watermark', async () => {
    const { store } = rig()
    await seed(store)
    const a = await placeOrder(store)
    const b = await placeOrder(store)
    const c = await placeOrder(store)
    await store.orders.markPaid(a.id, { provider: 'manual', reference: null }) // a is now the newest change

    const page1 = await store.orders.changedSince(null, null, 2)
    expect(page1.orders.map((o) => o.id)).toEqual([b.id, c.id])
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await store.orders.changedSince(null, page1.nextCursor, 2)
    expect(page2.orders.map((o) => o.id)).toEqual([a.id])
    expect(page2.nextCursor).toBeNull()

    const since = await store.orders.changedSince(c.updatedAt, null, 50)
    expect(since.orders.map((o) => o.id)).toEqual([c.id, a.id])
    await expect(store.orders.changedSince(null, '!!not-a-cursor', 10)).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('finds orders for the portal and guest lookup', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    expect(await store.orders.getWithKey(order.id, order.accessKey)).toMatchObject({ id: order.id })
    expect(await store.orders.getWithKey(order.id, 'wrong')).toBeNull()
    expect(await store.orders.byNumberAndEmail('#1001', 'ADA@example.com')).toMatchObject({ id: order.id })
    expect(await store.orders.byNumberAndEmail('1001', 'someone@else.test')).toBeNull()
    expect(await store.orders.byNumberAndEmail('abc', 'ada@example.com')).toBeNull()
    expect((await store.orders.forCustomer(order.customer.id)).map((o) => o.id)).toEqual([order.id])
    expect(await store.orders.getForCustomer(order.id, 'cus_other')).toBeNull()
  })
})

describe('abandoned checkouts', () => {
  it('expires processor checkouts older than the window, never manual ones', async () => {
    const { store, clock } = rig()
    await seed(store)
    const stripeOrder = await placeOrder(store)
    await store.orders.startPayment(stripeOrder.id, { provider: 'stripe', kind: 'redirect' })
    const manualOrder = await placeOrder(store)
    await store.orders.startPayment(manualOrder.id, { provider: 'manual', kind: 'instructions' })
    const neverStarted = await placeOrder(store) // adapter.start() failed: no provider recorded

    expect(await store.orders.expireAbandoned()).toBe(0) // too young
    clock.tick(23 * 3_600_000)
    expect(await store.orders.expireAbandoned()).toBe(0)
    clock.tick(2 * 3_600_000)
    const fresh = await placeOrder(store)
    await store.orders.startPayment(fresh.id, { provider: 'stripe', kind: 'redirect' })
    expect(await store.orders.expireAbandoned()).toBe(2)
    expect(await store.orders.expireAbandoned()).toBe(0) // idempotent

    const expired = await store.orders.require(stripeOrder.id)
    expect(expired.status).toBe('cancelled')
    expect(expired.cancelledAt).toBeTruthy()
    expect(expired.payment.status).toBe('unpaid')
    expect(expired.lines).toHaveLength(1)
    expect((await store.events.list(stripeOrder.id)).map((e) => e.type)).toEqual(['created', 'payment_started', 'abandoned'])
    expect((await store.orders.require(neverStarted.id)).status).toBe('cancelled')
    expect((await store.orders.require(manualOrder.id)).status).toBe('pending_payment')
    expect((await store.orders.require(fresh.id)).status).toBe('pending_payment')

    // A custom window.
    clock.tick(10 * 60_000)
    expect(await store.orders.expireAbandoned({ olderThanMinutes: 5 })).toBe(1)
    expect((await store.orders.require(fresh.id)).status).toBe('cancelled')
  })

  it('reopens an expired order as paid when the processor reports the payment late', async () => {
    const { store, mail, clock } = rig()
    await seed(store)
    await store.inventory.set([{ sku: 'VDCTOYTAC9504', available: 5 }])
    const order = await placeOrder(store)
    await store.orders.startPayment(order.id, { provider: 'stripe', kind: 'redirect' })
    clock.tick(25 * 3_600_000)
    expect(await store.orders.expireAbandoned()).toBe(1)

    const paid = await store.orders.markPaid(order.id, { provider: 'stripe', reference: 'pi_late', methodLabel: 'Card' })
    expect(paid.status).toBe('paid')
    expect(paid.payment).toMatchObject({ status: 'paid', provider: 'stripe', reference: 'pi_late' })
    expect(paid.cancelledAt).toBeNull()
    expect(paid.updatedAt > order.updatedAt).toBe(true)
    expect((await store.catalog.load()).product('VDCTOYTAC9504')!.availability?.quantity).toBe(4)
    expect((await store.events.list(order.id)).map((e) => e.type)).toEqual(['created', 'payment_started', 'abandoned', 'uncancelled', 'paid', 'email_sent'])
    expect(mail.sent.map((m) => m.subject)).toEqual(['Order 1001 confirmed — Test Store'])
    // It is not expired again, and it stays paid on redelivery.
    expect(await store.orders.expireAbandoned()).toBe(0)
    expect((await store.orders.markPaid(order.id, { provider: 'stripe', reference: 'pi_late' })).updatedAt).toBe(paid.updatedAt)
  })
})

describe('sessions', () => {
  it('signs a known customer in through a single-use magic link', async () => {
    const { store, mail, clock } = rig({ SESSION_SECRET: 's3cret' })
    await seed(store)
    expect(await store.sessions.sendMagicLink('nobody@example.com')).toBe(false)
    const order = await placeOrder(store)
    expect(await store.sessions.sendMagicLink('ada@example.com')).toBe(true)
    const url = mail.sent[0]!.text.match(/https:\/\/store\.test\/account\/verify\/\?token=([0-9a-f]+)/)!
    expect(url).toBeTruthy()
    const token = url[1]!

    const session = await store.sessions.exchange(token)
    expect(session.customer.id).toBe(order.customer.id)
    expect(session.token).toHaveLength(64)
    await expect(store.sessions.exchange(token)).rejects.toMatchObject({ code: 'not_found' }) // single use

    expect((await store.sessions.resolve(session.token))?.email).toBe('ada@example.com')
    expect(await store.sessions.resolve('garbage')).toBeNull()

    // Hashes, never tokens, in the database.
    const rows = store.db.prepare(`SELECT token_hash FROM customer_sessions`)
    expect((await rows.all<{ token_hash: string }>()).results[0]!.token_hash).not.toBe(session.token)

    await store.sessions.signOut(session.token)
    expect(await store.sessions.resolve(session.token)).toBeNull()

    const link = await store.sessions.createMagicLink('ada@example.com')
    clock.tick(16 * 60_000)
    await expect(store.sessions.exchange(link!.token)).rejects.toMatchObject({ code: 'not_found' }) // expired
  })

  it('expires sessions and prunes leftovers', async () => {
    const { store, clock } = rig()
    await seed(store)
    await placeOrder(store)
    const link = await store.sessions.createMagicLink('ada@example.com')
    const session = await store.sessions.exchange(link!.token)
    clock.tick(31 * 86_400_000)
    expect(await store.sessions.resolve(session.token)).toBeNull()
    await store.sessions.prune()
    expect((await store.db.prepare(`SELECT COUNT(*) AS n FROM customer_sessions`).first<{ n: number }>())!.n).toBe(0)
    expect((await store.db.prepare(`SELECT COUNT(*) AS n FROM magic_links`).first<{ n: number }>())!.n).toBe(0)
  })
})

describe('health', () => {
  it('reports identity and counts', async () => {
    const { store } = rig()
    await seed(store)
    await placeOrder(store)
    const health = await store.health()
    expect(health).toMatchObject({ name: 'Test Store', url: 'https://store.test', currency: 'USD', locale: 'en-US', counts: { products: 3, categories: 6, orders: 1, customers: 1 } })
    expect(health.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
