import { MAX_CART_LINES } from '../cart'
import type { DbStatement } from '../db/driver'
import { merchantQuoteMail, quoteReadyMail, quoteReceivedMail, type RenderedMail } from '../mail/templates'
import type { Address, Money, Order, QuoteLine, QuoteStatus, StoreQuote } from '../types'
import type { CatalogService } from './catalog'
import { checkShippingAddress, EMAIL, type CheckoutService, type PricedLine } from './checkout'
import { chunk, parseJson, placeholders, type StoreContext } from './context'
import { newId, randomToken } from './crypto'
import { normalizeEmail } from './customers'
import { conflict, invalid, notFound, StoreError } from './errors'
import type { OrdersService } from './orders'
import { cleanAddress } from './rows'

export interface QuoteRequestItem {
  sku: string
  quantity: number
}

/** What a buyer sends to ask for a quote. No account is needed: the email is the identity. */
export interface QuoteRequestInput {
  items: QuoteRequestItem[]
  email: string
  name: string
  phone?: string | null
  company?: string | null
  /** Lead time, intended use, delivery constraints — whatever the buyer wants priced in. */
  message?: string | null
  /** Optional at request time; required by the time the quote is accepted. */
  shippingAddress?: Address | null
  metadata?: Record<string, string>
}

/** The operations system's price for a quote. Replaces the lines: it may change quantities, drop or add SKUs. */
export interface QuoteOfferInput {
  lines: { sku: string; name?: string | null; quantity: number; unit_amount: Money }[]
  shipping?: Money | null
  tax?: Money | null
  /** ISO-8601; the offer lapses after it. Null or absent: open-ended. */
  expires_at?: string | null
  note?: string | null
  /** Email the buyer that the quote is ready (default true). */
  notify_customer?: boolean
}

export interface QuoteAcceptInput {
  /** Falls back to the address given with the request. One of the two must be complete. */
  shippingAddress?: Address | null
  phone?: string | null
  /** The buyer's purchase-order number, kept on the order's notes and metadata. */
  poNumber?: string | null
  notes?: string | null
}

export interface QuoteChangedPage {
  quotes: StoreQuote[]
  nextCursor: string | null
}

interface QuoteRow {
  id: string
  number: number
  status: string
  customer_id: string
  email: string
  customer_name: string | null
  customer_phone: string | null
  company: string | null
  message: string | null
  shipping_address_json: string | null
  currency: string
  subtotal: number | null
  shipping: number | null
  tax: number | null
  total: number | null
  offer_note: string | null
  expires_at: string | null
  external_reference: string | null
  order_id: string | null
  decline_reason: string | null
  metadata_json: string
  access_key: string
  created_at: string
  updated_at: string
  quoted_at: string | null
  accepted_at: string | null
  declined_at: string | null
  cancelled_at: string | null
}

interface QuoteLineRow {
  id: string
  quote_id: string
  sku: string
  name: string
  quantity: number
  list_amount: number | null
  unit_amount: number | null
  total_amount: number | null
  image_url: string | null
  position: number
}

const QUOTE_SELECT = `SELECT q.*, c.name AS customer_name, c.phone AS customer_phone FROM quotes q JOIN customers c ON c.id = q.customer_id`

/** Statuses an offer may be (re)made from: a fresh request, a live offer being revised, or a lapsed one being renewed. */
const OFFERABLE: QuoteStatus[] = ['requested', 'quoted', 'expired']

const encodeCursor = (updatedAt: string, id: string) => btoa(`${updatedAt}|${id}`).replace(/=+$/, '')
const decodeCursor = (cursor: string): { updatedAt: string; id: string } | null => {
  try {
    const raw = atob(cursor)
    const i = raw.lastIndexOf('|')
    return i < 0 ? null : { updatedAt: raw.slice(0, i), id: raw.slice(i + 1) }
  } catch {
    return null
  }
}

const clean = (v: string | null | undefined, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * Request for quote. A buyer asks for a price on products — signed in or as a guest who never makes an account —
 * the operations system prices it over the Store API (`PATCH /quotes/{id}` with an `offer`), and the buyer accepts
 * it, which places an order at exactly the offered prices, or declines it.
 *
 * The store never invents a price: a quote is either unpriced or carries the operations system's offer, and an
 * order only comes from the buyer accepting one.
 */
export class QuotesService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly catalog: CatalogService,
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService
  ) {}

  // ---- reads -------------------------------------------------------------

  async get(id: string): Promise<StoreQuote | null> {
    const [quote] = await this.hydrate(`${QUOTE_SELECT} WHERE q.id = ?`, [id])
    return quote ?? null
  }

  async require(id: string): Promise<StoreQuote> {
    const quote = await this.get(id)
    if (!quote) throw notFound('Quote')
    return quote
  }

  /** The emailed link's lookup: id plus the access key. This is how a guest gets back to their quote. */
  async getWithKey(id: string, key: string): Promise<StoreQuote | null> {
    const quote = await this.get(id)
    return quote && key && quote.accessKey === key ? quote : null
  }

  async forCustomer(customerId: string): Promise<StoreQuote[]> {
    return this.hydrate(`${QUOTE_SELECT} WHERE q.customer_id = ? ORDER BY q.created_at DESC, q.number DESC`, [customerId])
  }

  async getForCustomer(id: string, customerId: string): Promise<StoreQuote | null> {
    const [quote] = await this.hydrate(`${QUOTE_SELECT} WHERE q.id = ? AND q.customer_id = ?`, [id, customerId])
    return quote ?? null
  }

  async count(): Promise<number> {
    const row = await this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM quotes`).first<{ n: number }>()
    return row?.n ?? 0
  }

  /** Quotes changed since a watermark, oldest first, keyset-paged on (updated_at, id); `updatedSince` is inclusive. */
  async changedSince(updatedSince: string | null, cursor: string | null, limit: number): Promise<QuoteChangedPage> {
    const size = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)
    const where: string[] = []
    const args: (string | number)[] = []
    if (cursor) {
      const c = decodeCursor(cursor)
      if (!c) throw invalid('Invalid cursor', { cursor: 'is not a cursor this store issued' })
      where.push(`(q.updated_at, q.id) > (?, ?)`)
      args.push(c.updatedAt, c.id)
    } else if (updatedSince) {
      where.push(`q.updated_at >= ?`)
      args.push(updatedSince)
    }
    const quotes = await this.hydrate(`${QUOTE_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY q.updated_at ASC, q.id ASC LIMIT ?`, [...args, size + 1])
    const page = quotes.slice(0, size)
    const last = page[page.length - 1]
    return { quotes: page, nextCursor: quotes.length > size && last ? encodeCursor(last.updatedAt, last.id) : null }
  }

  async events(id: string): Promise<{ id: number; type: string; data: Record<string, unknown> | null; createdAt: string }[]> {
    const { results } = await this.ctx.db
      .prepare(`SELECT * FROM quote_events WHERE quote_id = ? ORDER BY id ASC`)
      .bind(id)
      .all<{ id: number; type: string; data_json: string | null; created_at: string }>()
    return results.map((r) => ({ id: r.id, type: r.type, data: parseJson<Record<string, unknown> | null>(r.data_json, null), createdAt: r.created_at }))
  }

  // ---- buyer -------------------------------------------------------------

  /**
   * Record a request for quote. The buyer needs no account and no password: the customer row is keyed by email,
   * exactly as a guest checkout's is, and the emailed access-key link is how they come back. Sold-out products may
   * be quoted (lead time is part of the answer); unknown or withdrawn ones may not. Throttled per email address.
   */
  async request(input: QuoteRequestInput): Promise<StoreQuote> {
    const details: Record<string, string> = {}
    const email = normalizeEmail(input.email ?? '')
    if (!EMAIL.test(email)) details.email = 'must be a valid email address'
    const name = clean(input.name, 200)
    if (!name) details.name = 'is required'
    const items = input.items ?? []
    if (!items.length) details.items = 'is empty'
    if (items.length > MAX_CART_LINES) details.items = `has more than ${MAX_CART_LINES} lines`
    const max = this.ctx.config.quotes.maxQuantity
    const catalog = await this.catalog.load()
    const merged = new Map<string, number>()
    items.forEach((item, i) => {
      const quantity = Number(item.quantity)
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
        details[`items.${i}.quantity`] = `must be a whole number from 1 to ${max}`
        return
      }
      if (!catalog.product(item.sku)) {
        details[`items.${i}.sku`] = 'is not a product in this store'
        return
      }
      merged.set(item.sku, Math.min((merged.get(item.sku) ?? 0) + quantity, max))
    })
    if (Object.keys(details).length) throw invalid('Quote request is incomplete', details)
    await this.assertNotFlooding(email)

    const db = this.ctx.db
    const now = this.ctx.now()
    const id = newId('quo')
    const address = cleanAddress(input.shippingAddress)
    if (address?.country) address.country = address.country.toUpperCase()
    const metadata = Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([, v]) => typeof v === 'string').slice(0, 20))
    const lines = [...merged].map(([sku, quantity], position) => {
      const product = catalog.product(sku)!
      return { sku, quantity, position, name: product.name, list: product.price.amount, image: product.images[0]?.src ?? null }
    })
    await db.batch([
      db
        .prepare(
          `INSERT INTO customers (id, email, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, customers.name), phone = COALESCE(excluded.phone, customers.phone), updated_at = excluded.updated_at`
        )
        .bind(newId('cus'), email, name, clean(input.phone, 50), now, now),
      db
        .prepare(
          `INSERT INTO quotes (id, number, status, customer_id, email, company, message, shipping_address_json, currency, metadata_json, access_key, created_at, updated_at)
           VALUES (?, (SELECT MAX(COALESCE(MAX(number), 0) + 1, ?) FROM quotes), 'requested', (SELECT id FROM customers WHERE email = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          this.ctx.config.quotes.numberStart,
          email,
          email,
          clean(input.company, 200),
          clean(input.message, 4000),
          address && Object.keys(address).length ? JSON.stringify(address) : null,
          this.ctx.config.currency.toUpperCase(),
          JSON.stringify(metadata),
          randomToken(16),
          now,
          now
        ),
      ...lines.map((l) =>
        db
          .prepare(`INSERT INTO quote_lines (id, quote_id, sku, name, quantity, list_amount, image_url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(newId('qln'), id, l.sku, l.name, l.quantity, l.list, l.image, l.position)
      ),
      this.event(id, 'requested', { lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity })) }),
    ])
    const quote = await this.require(id)
    await this.send(id, 'quote_received', quote.customer.email, quoteReceivedMail(quote, this.mailContext()))
    await this.notifyMerchant(quote, 'requested')
    return quote
  }

  /**
   * Accept a priced quote: places an order at exactly the offered prices (lines, shipping, tax) and links it. The
   * order is pay-later (`payment_provider: manual`, never expires) — the operations system invoices and marks it
   * paid, as B2B terms usually go; a store that wants card payment can start an adapter on the returned order.
   * A second accept returns the same order.
   */
  async accept(id: string, input: QuoteAcceptInput = {}): Promise<{ quote: StoreQuote; order: Order }> {
    await this.expireStale()
    const quote = await this.require(id)
    if (quote.status === 'accepted' && quote.orderId) return { quote, order: await this.orders.require(quote.orderId) }
    if (quote.status === 'expired') throw conflict('This quote has expired; ask for it to be renewed')
    if (quote.status !== 'quoted' || !quote.total) throw conflict(quote.status === 'requested' ? 'This quote has not been priced yet' : `A ${quote.status} quote cannot be accepted`)

    const details: Record<string, string> = {}
    const shipTo = checkShippingAddress(input.shippingAddress ?? quote.shippingAddress, details)
    if (Object.keys(details).length) throw invalid('A shipping address is needed to accept this quote', details)

    const now = this.ctx.now()
    // Claim the quote first so a double submit cannot place two orders.
    const claimed = await this.ctx.db
      .prepare(`UPDATE quotes SET status = 'accepted', accepted_at = ?, updated_at = ? WHERE id = ? AND status = 'quoted' AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(now, now, id, now)
      .run()
    if ((claimed.meta?.changes ?? 0) === 0) {
      const current = await this.require(id)
      if (current.status === 'accepted' && current.orderId) return { quote: current, order: await this.orders.require(current.orderId) }
      throw conflict('This quote changed while you were accepting it; reload it and try again')
    }

    const po = clean(input.poNumber, 100)
    const lines: PricedLine[] = quote.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitAmount: l.unitAmount!.amount,
      totalAmount: l.totalAmount!.amount,
      image: l.image ?? null,
    }))
    let order: Order
    try {
      order = await this.checkout.placePricedOrder({
        email: quote.customer.email,
        name: quote.customer.name ?? shipTo.name ?? null,
        phone: clean(input.phone, 50) ?? quote.customer.phone,
        currency: quote.currency,
        lines,
        subtotal: quote.subtotal!.amount,
        shipping: quote.shipping?.amount ?? 0,
        tax: quote.tax?.amount ?? 0,
        discount: 0,
        total: quote.total.amount,
        shippingAddress: shipTo,
        billingAddress: null,
        shippingMethod: { code: 'quote', name: `As quoted (${this.ctx.config.quotes.numberPrefix}${quote.number})` },
        notes: [po ? `PO ${po}` : null, clean(input.notes, 1800)].filter(Boolean).join('\n') || null,
        metadata: {
          quote_id: quote.id,
          quote_number: `${this.ctx.config.quotes.numberPrefix}${quote.number}`,
          ...(po ? { po_number: po } : {}),
          ...(quote.externalReference ? { quote_external_reference: quote.externalReference } : {}),
        },
        discountCode: null,
        discountPartner: null,
        commission: 0,
        createdEvent: { quote_id: quote.id },
      })
    } catch (error) {
      await this.ctx.db.prepare(`UPDATE quotes SET status = 'quoted', accepted_at = NULL, updated_at = ? WHERE id = ? AND status = 'accepted' AND order_id IS NULL`).bind(this.ctx.now(), id).run()
      throw error
    }
    await this.orders.startPayment(order.id, { provider: 'manual', kind: 'instructions' })
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE quotes SET order_id = ?, shipping_address_json = ?, updated_at = ? WHERE id = ?`).bind(order.id, JSON.stringify(shipTo), this.ctx.now(), id),
      this.event(id, 'accepted', { order_id: order.id, order_number: order.number, ...(po ? { po_number: po } : {}) }),
    ])
    const placed = await this.orders.require(order.id)
    await this.orders.notifyReceived(placed)
    const accepted = await this.require(id)
    await this.notifyMerchant(accepted, 'accepted', placed.number)
    return { quote: accepted, order: placed }
  }

  /** The buyer turns a quote down — before or after it is priced. */
  async decline(id: string, reason: string | null = null): Promise<StoreQuote> {
    const quote = await this.require(id)
    if (quote.status === 'declined') return quote
    if (quote.status !== 'requested' && quote.status !== 'quoted' && quote.status !== 'expired') throw conflict(`A ${quote.status} quote cannot be declined`)
    const now = this.ctx.now()
    const why = clean(reason, 1000)
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE quotes SET status = 'declined', declined_at = ?, decline_reason = ?, updated_at = ? WHERE id = ?`).bind(now, why, now, id),
      this.event(id, 'declined', why ? { reason: why } : null),
    ])
    const declined = await this.require(id)
    await this.notifyMerchant(declined, 'declined')
    return declined
  }

  // ---- operations system (Store API) ------------------------------------

  /**
   * Price a quote. The lines replace the request's: the operations system may change a quantity, drop a line or add
   * an alternative (a SKU the store does not list needs a `name`). Re-offering a live or lapsed quote revises it.
   */
  async offer(id: string, input: QuoteOfferInput): Promise<StoreQuote> {
    const quote = await this.require(id)
    if (!OFFERABLE.includes(quote.status)) throw conflict(`A ${quote.status} quote cannot be re-priced`)
    const currency = quote.currency.toUpperCase()
    const details: Record<string, string> = {}
    if (!input.lines.length) details['offer.lines'] = 'must have at least one line'
    if (input.lines.length > MAX_CART_LINES) details['offer.lines'] = `has more than ${MAX_CART_LINES} lines`
    const catalog = await this.catalog.load()
    const max = this.ctx.config.quotes.maxQuantity
    const requested = new Map(quote.lines.map((l) => [l.sku, l]))
    const seen = new Set<string>()
    const lines = input.lines.map((l, i) => {
      const product = catalog.product(l.sku)
      const name = clean(l.name, 300) ?? product?.name ?? requested.get(l.sku)?.name ?? null
      if (!name) details[`offer.lines.${i}.name`] = 'is required for a SKU this store does not list'
      if (seen.has(l.sku)) details[`offer.lines.${i}.sku`] = 'appears twice'
      seen.add(l.sku)
      if (l.quantity > max) details[`offer.lines.${i}.quantity`] = `must be at most ${max}`
      if (l.unit_amount.currency.toUpperCase() !== currency) details[`offer.lines.${i}.unit_amount.currency`] = `must be ${currency}`
      return {
        sku: l.sku,
        name: name ?? l.sku,
        quantity: l.quantity,
        unit: l.unit_amount.amount,
        total: l.unit_amount.amount * l.quantity,
        list: product?.price.amount ?? requested.get(l.sku)?.listAmount?.amount ?? null,
        image: product?.images[0]?.src ?? requested.get(l.sku)?.image ?? null,
      }
    })
    for (const [key, m] of [['shipping', input.shipping], ['tax', input.tax]] as const) {
      if (m && m.currency.toUpperCase() !== currency) details[`offer.${key}.currency`] = `must be ${currency}`
    }
    const now = this.ctx.now()
    if (input.expires_at && input.expires_at <= now) details['offer.expires_at'] = 'must be in the future'
    if (Object.keys(details).length) throw invalid('Offer is invalid', details)

    const subtotal = lines.reduce((n, l) => n + l.total, 0)
    const shipping = input.shipping?.amount ?? 0
    const tax = input.tax?.amount ?? 0
    const total = subtotal + shipping + tax
    const db = this.ctx.db
    const statements: DbStatement[] = [
      db.prepare(`DELETE FROM quote_lines WHERE quote_id = ?`).bind(id),
      ...lines.map((l, position) =>
        db
          .prepare(`INSERT INTO quote_lines (id, quote_id, sku, name, quantity, list_amount, unit_amount, total_amount, image_url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(newId('qln'), id, l.sku, l.name, l.quantity, l.list, l.unit, l.total, l.image, position)
      ),
      db
        .prepare(
          `UPDATE quotes SET status = 'quoted', subtotal = ?, shipping = ?, tax = ?, total = ?, offer_note = ?, expires_at = ?, quoted_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('requested', 'quoted', 'expired')`
        )
        .bind(subtotal, shipping, tax, total, clean(input.note, 4000), input.expires_at ?? null, now, now, id),
      this.event(id, quote.status === 'requested' ? 'quoted' : 'requoted', { total, lines: lines.length, expires_at: input.expires_at ?? null }),
    ]
    await db.batch(statements)
    const priced = await this.require(id)
    if (input.notify_customer !== false) await this.send(id, 'quote_ready', priced.customer.email, quoteReadyMail(priced, this.mailContext()))
    return priced
  }

  async setExternalReference(id: string, reference: string | null): Promise<StoreQuote> {
    const quote = await this.require(id)
    if (quote.externalReference === reference) return quote
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE quotes SET external_reference = ?, updated_at = ? WHERE id = ?`).bind(reference, now, id),
      this.event(id, 'external_reference_set', { reference }),
    ])
    return this.require(id)
  }

  /** The merchant withdraws a quote. An accepted one has an order: cancel that instead. */
  async cancel(id: string, reason: string | null = null): Promise<StoreQuote> {
    const quote = await this.require(id)
    if (quote.status === 'cancelled') return quote
    if (quote.status === 'accepted') throw conflict('An accepted quote has become an order; cancel the order instead')
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE quotes SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, id),
      this.event(id, 'cancelled', reason ? { reason } : null),
    ])
    return this.require(id)
  }

  /**
   * Lapse offers past their `expires_at`. Lazy, like abandoned checkouts: it runs at the start of the Store API quote
   * list and of an accept, so no cron is needed and a consumer never sees a lapsed offer as live.
   */
  async expireStale(limit = 200): Promise<number> {
    const now = this.ctx.now()
    const { results } = await this.ctx.db
      .prepare(`SELECT id FROM quotes WHERE status = 'quoted' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`)
      .bind(now, Math.min(Math.max(limit, 1), 500))
      .all<{ id: string }>()
    if (!results.length) return 0
    const statements = results.flatMap((r) => [
      this.ctx.db.prepare(`UPDATE quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'quoted'`).bind(now, r.id),
      this.event(r.id, 'expired'),
    ])
    for (const part of chunk(statements, 250)) await this.ctx.db.batch(part)
    return results.length
  }

  // ---- internals ---------------------------------------------------------

  private async assertNotFlooding(email: string): Promise<void> {
    const since = new Date(new Date(this.ctx.now()).getTime() - 3_600_000).toISOString()
    const row = await this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM quotes WHERE email = ? AND created_at > ?`).bind(email, since).first<{ n: number }>()
    if ((row?.n ?? 0) >= this.ctx.config.quotes.maxRequestsPerHour) {
      throw new StoreError('rate_limited', 'Too many quote requests from this address. Please try again in an hour, or contact us directly.')
    }
  }

  private event(quoteId: string, type: string, data: Record<string, unknown> | null = null): DbStatement {
    return this.ctx.db.prepare(`INSERT INTO quote_events (quote_id, type, data_json, created_at) VALUES (?, ?, ?, ?)`).bind(quoteId, type, data ? JSON.stringify(data) : null, this.ctx.now())
  }

  private mailContext() {
    return { config: this.ctx.config, siteUrl: this.ctx.siteUrl }
  }

  /** The merchant hears about requests and answers at QUOTE_NOTIFICATION_EMAIL, else ORDER_NOTIFICATION_EMAIL. */
  private async notifyMerchant(quote: StoreQuote, event: 'requested' | 'accepted' | 'declined', orderNumber?: string): Promise<void> {
    const to = this.ctx.env.QUOTE_NOTIFICATION_EMAIL || this.ctx.env.ORDER_NOTIFICATION_EMAIL
    if (to) await this.send(quote.id, `merchant_quote_${event}`, to, merchantQuoteMail(quote, this.mailContext(), event, orderNumber), quote.customer.email)
  }

  private async send(quoteId: string, kind: string, to: string, mail: RenderedMail, replyTo?: string): Promise<void> {
    try {
      await this.ctx.mail.send({ to, ...mail, ...(replyTo ? { replyTo } : {}) })
      await this.event(quoteId, 'email_sent', { kind, to }).run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.log(`quotes: ${kind} email failed`, { quoteId, to, error: message })
      await this.event(quoteId, 'email_failed', { kind, to, error: message }).run().catch(() => {})
    }
  }

  private async hydrate(sql: string, args: (string | number)[]): Promise<StoreQuote[]> {
    const { results: rows } = await this.ctx.db.prepare(sql).bind(...args).all<QuoteRow>()
    if (!rows.length) return []
    const lines = new Map<string, QuoteLineRow[]>()
    for (const part of chunk(rows.map((r) => r.id))) {
      const { results } = await this.ctx.db.prepare(`SELECT * FROM quote_lines WHERE quote_id IN (${placeholders(part.length)}) ORDER BY position, id`).bind(...part).all<QuoteLineRow>()
      for (const r of results) (lines.get(r.quote_id) ?? lines.set(r.quote_id, []).get(r.quote_id)!).push(r)
    }
    return rows.map((r) => rowToQuote(r, lines.get(r.id) ?? []))
  }
}

function rowToQuote(r: QuoteRow, lines: QuoteLineRow[]): StoreQuote {
  const money = (amount: number | null): Money | null => (amount === null || amount === undefined ? null : { amount, currency: r.currency })
  return {
    id: r.id,
    number: String(r.number),
    status: r.status as QuoteStatus,
    currency: r.currency,
    customer: { id: r.customer_id, email: r.email, name: r.customer_name, phone: r.customer_phone },
    company: r.company,
    message: r.message,
    shippingAddress: r.shipping_address_json ? parseJson<Address | null>(r.shipping_address_json, null) : null,
    lines: lines.map(
      (l): QuoteLine => ({
        id: l.id,
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        listAmount: money(l.list_amount),
        unitAmount: money(l.unit_amount),
        totalAmount: money(l.total_amount),
        ...(l.image_url ? { image: l.image_url } : {}),
      })
    ),
    subtotal: money(r.subtotal),
    shipping: money(r.shipping),
    tax: money(r.tax),
    total: money(r.total),
    offerNote: r.offer_note,
    expiresAt: r.expires_at,
    externalReference: r.external_reference,
    orderId: r.order_id,
    declineReason: r.decline_reason,
    metadata: parseJson<Record<string, string>>(r.metadata_json, {}),
    accessKey: r.access_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    quotedAt: r.quoted_at,
    acceptedAt: r.accepted_at,
    declinedAt: r.declined_at,
    cancelledAt: r.cancelled_at,
  }
}
