import type { DbStatement } from '../db/driver'
import { merchantNewOrderMail, orderConfirmationMail, shippingConfirmationMail } from '../mail/templates'
import type { Fulfillment, Money, Order, OrderStatus } from '../types'
import { chunk, placeholders, type StoreContext } from './context'
import { newId } from './crypto'
import { normalizeEmail } from './customers'
import { conflict, invalid, notFound } from './errors'
import type { EventsService } from './events'
import type { InventoryService } from './inventory'
import { ORDER_SELECT, rowToFulfillment, rowToOrder, type FulfillmentLineRow, type FulfillmentRow, type OrderLineRow, type OrderRow } from './rows'

export interface PaymentRecord {
  provider: string
  reference?: string | null
  methodLabel?: string | null
  paidAt?: string | null
  /** What the processor actually charged, when it may differ from the order (promotion codes). */
  amount?: Money
  adjustments?: { discount?: Money; tax?: Money; total?: Money }
}

export interface FulfillmentInput {
  external_id: string
  carrier?: string | null
  service?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  shipped_at?: string | null
  lines: { sku: string; quantity: number }[]
  notify_customer?: boolean
}

/** Processor checkouts still unpaid after this long are treated as abandoned. */
export const ABANDONED_AFTER_MINUTES = 1440

export interface ChangedPage {
  orders: Order[]
  nextCursor: string | null
}

const encodeCursor = (updatedAt: string, id: string) => btoa(`${updatedAt}|${id}`).replace(/=+$/, '')
const decodeCursor = (cursor: string): { updatedAt: string; id: string } | null => {
  try {
    const raw = atob(cursor)
    const i = raw.lastIndexOf('|')
    if (i < 0) return null
    return { updatedAt: raw.slice(0, i), id: raw.slice(i + 1) }
  } catch {
    return null
  }
}

export class OrdersService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly events: EventsService,
    private readonly inventory: InventoryService
  ) {}

  // ---- reads -------------------------------------------------------------

  async get(id: string): Promise<Order | null> {
    const [order] = await this.hydrate(`${ORDER_SELECT} WHERE o.id = ?`, [id])
    return order ?? null
  }

  async require(id: string): Promise<Order> {
    const order = await this.get(id)
    if (!order) throw notFound('Order')
    return order
  }

  /** The confirmation page's lookup: id plus the access key issued at checkout. */
  async getWithKey(id: string, key: string): Promise<Order | null> {
    const order = await this.get(id)
    return order && key && order.accessKey === key ? order : null
  }

  /** Guest order status: number plus the email it was placed with. */
  async byNumberAndEmail(number: string, email: string): Promise<Order | null> {
    const digits = number.replace(/^\D+/, '')
    if (!/^\d+$/.test(digits)) return null
    const [order] = await this.hydrate(`${ORDER_SELECT} WHERE o.number = ? AND o.email = ?`, [Number(digits), normalizeEmail(email)])
    return order ?? null
  }

  async forCustomer(customerId: string): Promise<Order[]> {
    return this.hydrate(`${ORDER_SELECT} WHERE o.customer_id = ? ORDER BY o.created_at DESC, o.number DESC`, [customerId])
  }

  async getForCustomer(id: string, customerId: string): Promise<Order | null> {
    const [order] = await this.hydrate(`${ORDER_SELECT} WHERE o.id = ? AND o.customer_id = ?`, [id, customerId])
    return order ?? null
  }

  async byPaymentReference(provider: string, reference: string): Promise<Order | null> {
    const [order] = await this.hydrate(`${ORDER_SELECT} WHERE o.payment_provider = ? AND o.payment_reference = ?`, [provider, reference])
    return order ?? null
  }

  /** Newest first, for the owner's order list. Unpaid processor checkouts are left out unless asked for. */
  async recent(opts: { limit?: number; includeUnpaid?: boolean } = {}): Promise<Order[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    const where = opts.includeUnpaid ? '' : ` WHERE o.payment_status != 'unpaid' OR COALESCE(o.payment_provider, 'manual') = 'manual'`
    return this.hydrate(`${ORDER_SELECT}${where} ORDER BY o.created_at DESC, o.number DESC LIMIT ?`, [limit])
  }

  async count(): Promise<number> {
    const row = await this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM orders`).first<{ n: number }>()
    return row?.n ?? 0
  }

  /**
   * Orders changed since a watermark, oldest first, keyset-paged on
   * (updated_at, id). `updatedSince` is inclusive so a consumer can overlap.
   */
  async changedSince(updatedSince: string | null, cursor: string | null, limit: number): Promise<ChangedPage> {
    const size = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)
    const where: string[] = []
    const args: (string | number)[] = []
    if (cursor) {
      const c = decodeCursor(cursor)
      if (!c) throw invalid('Invalid cursor', { cursor: 'is not a cursor this store issued' })
      where.push(`(o.updated_at, o.id) > (?, ?)`)
      args.push(c.updatedAt, c.id)
    } else if (updatedSince) {
      where.push(`o.updated_at >= ?`)
      args.push(updatedSince)
    }
    const sql = `${ORDER_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY o.updated_at ASC, o.id ASC LIMIT ?`
    const orders = await this.hydrate(sql, [...args, size + 1])
    const page = orders.slice(0, size)
    const last = page[page.length - 1]
    return { orders: page, nextCursor: orders.length > size && last ? encodeCursor(last.updatedAt, last.id) : null }
  }

  private async hydrate(sql: string, args: (string | number)[]): Promise<Order[]> {
    const { results: rows } = await this.ctx.db.prepare(sql).bind(...args).all<OrderRow>()
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const lines = new Map<string, OrderLineRow[]>()
    const fulfillments = new Map<string, FulfillmentRow[]>()
    const fulfillmentLines = new Map<string, FulfillmentLineRow[]>()
    for (const part of chunk(ids)) {
      const ph = placeholders(part.length)
      const [l, f, fl] = await Promise.all([
        this.ctx.db.prepare(`SELECT * FROM order_lines WHERE order_id IN (${ph}) ORDER BY position, id`).bind(...part).all<OrderLineRow>(),
        this.ctx.db.prepare(`SELECT * FROM fulfillments WHERE order_id IN (${ph}) ORDER BY created_at, id`).bind(...part).all<FulfillmentRow>(),
        this.ctx.db
          .prepare(`SELECT fl.* FROM fulfillment_lines fl JOIN fulfillments f ON f.id = fl.fulfillment_id WHERE f.order_id IN (${ph}) ORDER BY fl.sku`)
          .bind(...part)
          .all<FulfillmentLineRow>(),
      ])
      for (const r of l.results) (lines.get(r.order_id) ?? lines.set(r.order_id, []).get(r.order_id)!).push(r)
      for (const r of f.results) (fulfillments.get(r.order_id) ?? fulfillments.set(r.order_id, []).get(r.order_id)!).push(r)
      for (const r of fl.results) (fulfillmentLines.get(r.fulfillment_id) ?? fulfillmentLines.set(r.fulfillment_id, []).get(r.fulfillment_id)!).push(r)
    }
    return rows.map((r) =>
      rowToOrder(
        r,
        lines.get(r.id) ?? [],
        (fulfillments.get(r.id) ?? []).map((f) => rowToFulfillment(f, fulfillmentLines.get(f.id) ?? []))
      )
    )
  }

  // ---- writes ------------------------------------------------------------

  /**
   * Record which adapter took the order to payment. `provider` is what
   * `expireAbandoned` uses to tell a processor checkout (which can be
   * abandoned) from a `manual` order (which waits as long as it takes).
   */
  async startPayment(id: string, input: { provider: string; kind: 'redirect' | 'instructions' }): Promise<void> {
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE orders SET payment_provider = ?, updated_at = ? WHERE id = ? AND payment_status = 'unpaid'`).bind(input.provider, now, id),
      this.events.statement(id, 'payment_started', { provider: input.provider, kind: input.kind }),
    ])
  }

  /**
   * Cancel processor checkouts the buyer never finished: every
   * `pending_payment` order older than the window whose adapter is not
   * `manual`. Called lazily (Store API order list, checkout endpoint), so no
   * cron is needed; a payment that arrives later reopens the order (markPaid).
   */
  async expireAbandoned(opts: { olderThanMinutes?: number; limit?: number } = {}): Promise<number> {
    const minutes = opts.olderThanMinutes ?? ABANDONED_AFTER_MINUTES
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
    const now = this.ctx.now()
    const cutoff = new Date(new Date(now).getTime() - minutes * 60_000).toISOString()
    const { results } = await this.ctx.db
      .prepare(`SELECT id FROM orders WHERE status = 'pending_payment' AND COALESCE(payment_provider, '') != 'manual' AND created_at < ? ORDER BY created_at LIMIT ?`)
      .bind(cutoff, limit)
      .all<{ id: string }>()
    if (results.length === 0) return 0
    const statements = results.flatMap((r) => [
      this.ctx.db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment'`).bind(now, now, r.id),
      this.events.statement(r.id, 'abandoned', { after_minutes: minutes }),
    ])
    for (const part of chunk(statements, 250)) await this.ctx.db.batch(part)
    return results.length
  }

  /**
   * Record a successful payment. Idempotent: a second call for an order that
   * is already paid returns it unchanged, so webhook redelivery is harmless.
   * A cancelled order (abandoned and expired, or cancelled by operations) that
   * the processor reports paid is reopened as `paid` — money arrived, and a
   * paid order is never lost.
   */
  async markPaid(id: string, payment: PaymentRecord, opts: { notify?: boolean } = {}): Promise<Order> {
    const order = await this.require(id)
    if (order.payment.status === 'paid') return order
    if (order.payment.status === 'refunded') {
      this.ctx.log('orders: ignoring a payment for a refunded order', { id, provider: payment.provider, reference: payment.reference })
      return order
    }
    const reopened = order.status === 'cancelled'
    if (reopened) this.ctx.log('orders: payment arrived for a cancelled order; reopening it', { id, provider: payment.provider, reference: payment.reference })
    const now = this.ctx.now()
    const paidAt = payment.paidAt ?? now
    const discount = payment.adjustments?.discount?.amount ?? order.discount.amount
    const tax = payment.adjustments?.tax?.amount ?? order.tax.amount
    const total = payment.adjustments?.total?.amount ?? payment.amount?.amount ?? order.subtotal.amount + order.shipping.amount + tax - discount
    const nextStatus: OrderStatus = order.status === 'pending_payment' || reopened ? 'paid' : order.status
    const statements: DbStatement[] = [
      this.ctx.db
        .prepare(
          `UPDATE orders SET status = ?, payment_status = 'paid', payment_provider = ?, payment_reference = ?, payment_method_label = ?, paid_at = ?,
             discount = ?, tax = ?, total = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`
        )
        .bind(nextStatus, payment.provider, payment.reference ?? null, payment.methodLabel ?? null, paidAt, discount, tax, total, reopened ? null : order.cancelledAt, now, id),
      this.ctx.db
        .prepare(`INSERT INTO payments (id, order_id, provider, reference, status, amount, currency, method_label, created_at) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?)`)
        .bind(newId('pay'), id, payment.provider, payment.reference ?? null, total, order.currency, payment.methodLabel ?? null, now),
      ...this.inventory.adjustStatements(order.lines, -1),
      ...(reopened ? [this.events.statement(id, 'uncancelled', { reason: 'payment received', provider: payment.provider })] : []),
      this.events.statement(id, 'paid', { provider: payment.provider, reference: payment.reference ?? null, total }),
    ]
    await this.ctx.db.batch(statements)
    const updated = await this.require(id)
    if (opts.notify !== false) await this.notifyPaid(updated)
    return updated
  }

  async setPaymentStatus(id: string, input: { status: 'paid' | 'refunded' | 'failed'; provider?: string | null; reference?: string | null; paid_at?: string | null }): Promise<Order> {
    if (input.status === 'paid') {
      return this.markPaid(id, { provider: input.provider ?? 'manual', reference: input.reference ?? null, paidAt: input.paid_at ?? null })
    }
    const order = await this.require(id)
    const now = this.ctx.now()
    if (input.status === 'refunded') {
      if (order.payment.status === 'refunded') return order
      if (order.payment.status !== 'paid') throw conflict('Only a paid order can be refunded')
      await this.ctx.db.batch([
        this.ctx.db
          .prepare(`UPDATE orders SET status = 'refunded', payment_status = 'refunded', payment_provider = COALESCE(?, payment_provider), payment_reference = COALESCE(?, payment_reference), updated_at = ? WHERE id = ?`)
          .bind(input.provider ?? null, input.reference ?? null, now, id),
        this.ctx.db
          .prepare(`INSERT INTO payments (id, order_id, provider, reference, status, amount, currency, method_label, created_at) VALUES (?, ?, ?, ?, 'refunded', ?, ?, ?, ?)`)
          .bind(newId('pay'), id, input.provider ?? order.payment.provider ?? 'manual', input.reference ?? order.payment.reference, -order.total.amount, order.currency, order.payment.methodLabel, now),
        this.events.statement(id, 'refunded', { provider: input.provider ?? null, reference: input.reference ?? null }),
      ])
      return this.require(id)
    }
    // failed: the order stays open for another attempt.
    if (order.payment.status === 'paid') throw conflict('A paid order cannot be marked failed')
    await this.ctx.db.batch([
      this.ctx.db
        .prepare(`UPDATE orders SET payment_status = 'failed', payment_provider = COALESCE(?, payment_provider), payment_reference = COALESCE(?, payment_reference), updated_at = ? WHERE id = ?`)
        .bind(input.provider ?? null, input.reference ?? null, now, id),
      this.events.statement(id, 'payment_failed', { provider: input.provider ?? null, reference: input.reference ?? null }),
    ])
    return this.require(id)
  }

  async cancel(id: string, reason: string | null = null): Promise<Order> {
    const order = await this.require(id)
    if (order.status === 'cancelled') return order
    if (order.status === 'fulfilled' || order.status === 'partially_fulfilled') throw conflict('An order that has shipped cannot be cancelled')
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, id),
      ...(order.payment.status === 'paid' ? this.inventory.adjustStatements(order.lines, 1) : []),
      this.events.statement(id, 'cancelled', reason ? { reason } : null),
    ])
    return this.require(id)
  }

  async setExternalReference(id: string, reference: string | null): Promise<Order> {
    const order = await this.require(id)
    if (order.externalReference === reference) return order
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE orders SET external_reference = ?, updated_at = ? WHERE id = ?`).bind(reference, now, id),
      this.events.statement(id, 'external_reference_set', { reference }),
    ])
    return this.require(id)
  }

  /**
   * Record a shipment. Idempotent per (order, external_id): a redelivery
   * returns the existing fulfilment with `created: false` and sends nothing.
   */
  async addFulfillment(id: string, input: FulfillmentInput): Promise<{ order: Order; fulfillment: Fulfillment; created: boolean }> {
    const order = await this.require(id)
    const existing = order.fulfillments.find((f) => f.externalId === input.external_id)
    if (existing) return { order, fulfillment: existing, created: false }
    if (order.status === 'cancelled') throw conflict('A cancelled order cannot be fulfilled')

    const details: Record<string, string> = {}
    const merged = new Map<string, number>()
    input.lines.forEach((l, i) => {
      const line = order.lines.find((ol) => ol.sku === l.sku)
      if (!line) {
        details[`lines.${i}.sku`] = `is not on this order`
        return
      }
      merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.quantity)
      const remaining = line.quantity - line.fulfilledQuantity
      if (merged.get(l.sku)! > remaining) details[`lines.${i}.quantity`] = `exceeds the ${remaining} unfulfilled unit(s) of ${l.sku}`
    })
    if (Object.keys(details).length) throw invalid('Fulfilment lines do not match the order', details)

    const now = this.ctx.now()
    const fulfillmentId = newId('ful')
    const statements: DbStatement[] = [
      this.ctx.db
        .prepare(`INSERT INTO fulfillments (id, order_id, external_id, carrier, service, tracking_number, tracking_url, shipped_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(fulfillmentId, id, input.external_id, input.carrier ?? null, input.service ?? null, input.tracking_number ?? null, input.tracking_url ?? null, input.shipped_at ?? null, now),
    ]
    for (const [sku, quantity] of merged) {
      statements.push(this.ctx.db.prepare(`INSERT INTO fulfillment_lines (fulfillment_id, sku, quantity) VALUES (?, ?, ?)`).bind(fulfillmentId, sku, quantity))
      statements.push(this.ctx.db.prepare(`UPDATE order_lines SET fulfilled_quantity = fulfilled_quantity + ? WHERE order_id = ? AND sku = ?`).bind(quantity, id, sku))
    }
    const allDone = order.lines.every((l) => l.fulfilledQuantity + (merged.get(l.sku) ?? 0) >= l.quantity)
    const nextStatus: OrderStatus = allDone ? 'fulfilled' : 'partially_fulfilled'
    statements.push(this.ctx.db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`).bind(nextStatus, now, id))
    statements.push(this.events.statement(id, 'fulfillment_added', { fulfillment: fulfillmentId, external_id: input.external_id, tracking_number: input.tracking_number ?? null }))
    await this.ctx.db.batch(statements)

    const updated = await this.require(id)
    const fulfillment = updated.fulfillments.find((f) => f.id === fulfillmentId)!
    if (input.notify_customer !== false) await this.notifyShipped(updated, fulfillment)
    return { order: updated, fulfillment, created: true }
  }

  // ---- notifications -----------------------------------------------------

  private mailContext() {
    return { config: this.ctx.config, siteUrl: this.ctx.siteUrl }
  }

  /** Buyer confirmation plus the merchant notification. Failures are logged, never thrown. */
  async notifyPaid(order: Order): Promise<void> {
    const buyer = orderConfirmationMail(order, this.mailContext())
    await this.send(order.id, 'order_confirmation', order.customer.email, buyer)
    const merchant = this.ctx.env.ORDER_NOTIFICATION_EMAIL
    if (merchant) await this.send(order.id, 'merchant_notification', merchant, merchantNewOrderMail(order, this.mailContext()), order.customer.email)
  }

  /** Order received but not yet paid (manual payment). */
  async notifyReceived(order: Order): Promise<void> {
    await this.send(order.id, 'order_received', order.customer.email, orderConfirmationMail(order, this.mailContext()))
  }

  async notifyShipped(order: Order, fulfillment: Fulfillment): Promise<void> {
    const sent = await this.send(order.id, 'shipping_confirmation', order.customer.email, shippingConfirmationMail(order, fulfillment, this.mailContext()))
    if (sent) await this.ctx.db.prepare(`UPDATE fulfillments SET notified_at = ? WHERE id = ?`).bind(this.ctx.now(), fulfillment.id).run()
  }

  private async send(orderId: string, kind: string, to: string, mail: { subject: string; html: string; text: string }, replyTo?: string): Promise<boolean> {
    try {
      await this.ctx.mail.send({ to, ...mail, ...(replyTo ? { replyTo } : {}) })
      await this.events.record(orderId, 'email_sent', { kind, to })
      return true
    } catch (error) {
      this.ctx.log(`orders: ${kind} email failed`, { orderId, to, error: error instanceof Error ? error.message : String(error) })
      await this.events.record(orderId, 'email_failed', { kind, to, error: error instanceof Error ? error.message : String(error) }).catch(() => {})
      return false
    }
  }
}
