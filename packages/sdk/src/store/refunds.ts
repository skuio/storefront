import type { DbStatement } from '../db/driver'
import type { ProcessorRefund, RefundRequest, RefundResult } from '../payments'
import type { Money, Order, OrderRefund, RefundLine, RefundStatus } from '../types'
import type { StoreContext } from './context'
import { newId } from './crypto'
import { invalid, notFound, refundUnsupported } from './errors'
import type { EventsService } from './events'
import type { OrdersService } from './orders'
import { rowToRefund, type RefundRow } from './rows'

/** `POST /orders/{id}/refunds`, validated. Amounts are integer minor units. */
export interface RefundInput {
  /** 1..100 characters; the same key on the same order returns the first refund and never calls the processor again. */
  idempotency_key: string
  amount: Money
  shipping?: Money | null
  lines?: RefundLine[]
  reason?: string | null
  note?: string | null
  notify_customer?: boolean
}

/**
 * The processor side of a refund, handed in by the caller (the Store API, from the order's
 * `PaymentAdapter`): the store core itself never talks to a processor.
 */
/** How long after a refund's creation a replay of its idempotency key is still safe (Stripe keeps keys 24h). */
export const REPLAY_WINDOW_HOURS = 23

const addHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * 3_600_000).toISOString()

export interface Refunder {
  /** The adapter id; must be the provider that took the order's payment. */
  provider: string
  refund(order: Order, request: RefundRequest): Promise<RefundResult>
}

export interface RefundOutcome {
  order: Order
  refund: OrderRefund
  /** False when the idempotency key was seen before: the existing refund, nothing sent to the processor. */
  created: boolean
  /** Set when the processor refused (or could not be reached): the row is stored `failed`. */
  processorError: string | null
}

/** What a paid order took in, what has gone back (pending + succeeded), and what is left. Minor units, order currency. */
export interface RefundTotals {
  received: Money
  refunded: Money
  refundable: Money
}

/**
 * Received, refunded and still refundable for an order. Received is what the processor captured
 * (`payment.amountReceived`, when in the order currency) or else the order total. Nothing is
 * refundable unless the payment status is `paid` (a partly refunded order stays `paid`).
 */
export function refundTotals(order: Order): RefundTotals {
  const currency = order.currency
  const same = (m: Money) => m.currency.toLowerCase() === currency.toLowerCase()
  const received = order.payment.amountReceived && same(order.payment.amountReceived) ? order.payment.amountReceived.amount : order.total.amount
  const refunded = (order.refunds ?? []).filter((r) => r.status !== 'failed' && same(r.amount)).reduce((sum, r) => sum + r.amount.amount, 0)
  const left = order.payment.status === 'paid' ? Math.max(received - refunded, 0) : 0
  return { received: { amount: received, currency }, refunded: { amount: refunded, currency }, refundable: { amount: left, currency } }
}

/** Refund statuses that hold money back from what is still refundable. */
const COUNTED = `status IN ('pending', 'succeeded')`

const MAX_FAILURE_REASON = 500

/**
 * Refunds of paid orders: asked for through the Store API (`create`) or reported by the processor
 * (`recordFromProcessor`). One row per refund in `order_refunds`; once the succeeded refunds reach
 * what was received, the order's payment becomes `refunded`.
 */
export class RefundsService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly events: EventsService,
    private readonly orders: OrdersService
  ) {}

  async list(orderId: string): Promise<OrderRefund[]> {
    await this.orders.require(orderId)
    const { results } = await this.ctx.db.prepare(`SELECT * FROM order_refunds WHERE order_id = ? ORDER BY created_at, id`).bind(orderId).all<RefundRow>()
    return results.map(rowToRefund)
  }

  async require(orderId: string, refundId: string): Promise<OrderRefund> {
    const row = await this.ctx.db.prepare(`SELECT * FROM order_refunds WHERE order_id = ? AND id = ?`).bind(orderId, refundId).first<RefundRow>()
    if (!row) throw notFound('Refund')
    return rowToRefund(row)
  }

  private async byKey(orderId: string, key: string): Promise<OrderRefund | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM order_refunds WHERE order_id = ? AND idempotency_key = ?`).bind(orderId, key).first<RefundRow>()
    return row ? rowToRefund(row) : null
  }

  private async byId(id: string): Promise<OrderRefund | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM order_refunds WHERE id = ?`).bind(id).first<RefundRow>()
    return row ? rowToRefund(row) : null
  }

  private async byReference(provider: string, reference: string): Promise<OrderRefund | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM order_refunds WHERE provider = ? AND reference = ?`).bind(provider, reference).first<RefundRow>()
    return row ? rowToRefund(row) : null
  }

  /**
   * Refund part or all of a paid order through `refunder` (null: the order's processor cannot refund).
   *
   * Idempotent per `(order, idempotency_key)`: a key seen before returns that refund (whatever its
   * status) without calling the processor. The amount is reserved by a single conditional insert that
   * sums the order's pending and succeeded refunds in the same statement, so concurrent requests can
   * never give back more than was received; a request that loses that race gets 422.
   */
  async create(orderId: string, input: RefundInput, refunder: Refunder | null): Promise<RefundOutcome> {
    const order = await this.orders.require(orderId)
    const seen = await this.byKey(orderId, input.idempotency_key)
    if (seen) return { order, refund: seen, created: false, processorError: null }

    const provider = order.payment.provider ?? 'manual'
    if (order.payment.status !== 'paid') {
      throw refundUnsupported(order.payment.status === 'refunded' ? 'This order is already fully refunded' : `Only a paid order can be refunded; this one is ${order.payment.status}`)
    }
    if (!refunder || refunder.provider !== provider) {
      throw refundUnsupported(`This order was paid by ${order.payment.methodLabel ?? provider}, which this store cannot refund; refund it outside the store`)
    }
    if (!order.payment.reference && !order.payment.transactionId) throw refundUnsupported('This order has no processor payment reference to refund')

    this.checkAgainstOrder(order, input)
    const totals = refundTotals(order)
    if (input.amount.amount > totals.refundable.amount) {
      throw invalid('The refund is more than the order has left to refund', { amount: `exceeds the refundable ${totals.refundable.amount} (${order.currency.toUpperCase()} minor units)` })
    }

    // Reserve: insert as pending only if the order is still paid and the amount still fits.
    const now = this.ctx.now()
    const id = newId('rf')
    const currency = order.currency
    await this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO order_refunds (id, order_id, status, amount, currency, shipping, lines_json, reason, note, provider, reference, failure_reason, idempotency_key, source, notify_customer, created_at, updated_at)
         SELECT ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'api', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND payment_status = 'paid')
           AND (SELECT COALESCE(SUM(amount), 0) FROM order_refunds WHERE order_id = ? AND ${COUNTED}) + ? <= ?`
      )
      .bind(
        id, orderId, input.amount.amount, currency, input.shipping ? input.shipping.amount : null,
        JSON.stringify((input.lines ?? []).map((l) => ({ sku: l.sku, quantity: l.quantity, amount: { amount: l.amount.amount, currency } }))),
        input.reason ?? null, input.note ?? null, provider, input.idempotency_key, input.notify_customer ? 1 : 0, now, now,
        orderId, orderId, input.amount.amount, totals.received.amount
      )
      .run()
    const reserved = await this.byKey(orderId, input.idempotency_key)
    // A concurrent request with the same key got there first: answer as a replay.
    if (reserved && reserved.id !== id) return { order: await this.orders.require(orderId), refund: reserved, created: false, processorError: null }
    if (!reserved) {
      const now2 = await this.orders.require(orderId)
      if (now2.payment.status !== 'paid') throw refundUnsupported('This order is no longer paid')
      throw invalid('The refund is more than the order has left to refund', { amount: `exceeds the refundable ${refundTotals(now2).refundable.amount} (${order.currency.toUpperCase()} minor units)` })
    }

    let result: RefundResult
    try {
      result = await refunder.refund(order, { refundId: id, amount: { amount: input.amount.amount, currency }, reason: input.reason ?? null, idempotencyKey: `storefront-refund-${id}` })
    } catch (e) {
      // Unknown outcome (timeout, network, 5xx): the money may have moved. Stay `pending` so the amount
      // stays reserved and nobody retries under a new key; a GET replays the same idempotency key
      // (`refreshPending`) and a processor webhook carrying the refund id settles it.
      this.ctx.log('refunds: the processor did not answer; the refund stays pending', { orderId, refund: id, error: e instanceof Error ? e.message : String(e) })
      result = { status: 'pending', reference: null, failureReason: null }
    }
    if (result.status === 'failed' && !result.failureReason) result = { ...result, failureReason: 'The processor refused the refund' }

    await this.apply(reserved, order, result, { requested: true })
    const refund = (await this.byId(id))!
    const updated = await this.orders.require(orderId)
    if (input.notify_customer && refund.status !== 'failed') await this.orders.notifyRefunded(updated, refund)
    return { order: updated, refund, created: true, processorError: refund.status === 'failed' ? refund.failureReason : null }
  }

  /** Lines must be on the order (quantity at most what was ordered), currencies the order's, shipping at most the amount. */
  private checkAgainstOrder(order: Order, input: RefundInput): void {
    const details: Record<string, string> = {}
    const currency = order.currency.toLowerCase()
    const wrong = (m: Money) => m.currency.toLowerCase() !== currency
    if (input.amount.amount <= 0) details.amount = 'must be greater than zero'
    if (wrong(input.amount)) details['amount.currency'] = `must be the order currency ${currency.toUpperCase()}`
    if (input.shipping) {
      if (wrong(input.shipping)) details['shipping.currency'] = `must be the order currency ${currency.toUpperCase()}`
      if (input.shipping.amount > input.amount.amount) details.shipping = 'must not be more than amount'
    }
    ;(input.lines ?? []).forEach((l, i) => {
      const line = order.lines.find((ol) => ol.sku === l.sku)
      if (!line) details[`lines.${i}.sku`] = 'is not on this order'
      else if (l.quantity > line.quantity) details[`lines.${i}.quantity`] = `exceeds the ${line.quantity} ordered`
      if (wrong(l.amount)) details[`lines.${i}.amount.currency`] = `must be the order currency ${currency.toUpperCase()}`
    })
    if (Object.keys(details).length) throw invalid('The refund does not match the order', details)
  }

  /**
   * Re-check `pending` refunds that have a processor reference through `check` (the adapter's
   * `refundStatus`). Errors and unknown answers leave the row as it is.
   */
  async refreshPending(
    orderId: string,
    provider: string,
    check: (order: Order, reference: string) => Promise<RefundResult | null>,
    replay?: Refunder['refund'],
  ): Promise<void> {
    const order = await this.orders.require(orderId)
    for (const refund of order.refunds ?? []) {
      if (refund.status !== 'pending' || refund.provider !== provider) continue
      // No reference = the processor never answered the original call. Replaying the same idempotency
      // key returns that call's outcome instead of refunding again — but only inside the processor's
      // key window (Stripe keeps keys 24h); past it a replay could refund twice, so leave it to the webhook.
      if (!refund.reference && (!replay || this.ctx.now() > addHours(refund.createdAt, REPLAY_WINDOW_HOURS))) continue
      try {
        const result = refund.reference
          ? await check(order, refund.reference)
          : await replay!(order, { refundId: refund.id, amount: refund.amount, reason: refund.reason, idempotencyKey: `storefront-refund-${refund.id}` })
        if (result && result.status !== 'pending') await this.apply(refund, order, { ...result, reference: result.reference ?? refund.reference }, { requested: false })
      } catch (e) {
        this.ctx.log('refunds: could not re-check a pending refund', { orderId, refund: refund.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  /**
   * A refund the processor reported (webhook). Updates the row it belongs to — by the store's refund
   * id the processor carried back, else by the processor's refund id — or, for a refund made in the
   * processor's dashboard, inserts one with `source: "processor"`. Returns the order, or null when
   * the processor's payment is not one of this store's orders.
   */
  async recordFromProcessor(report: { orderId: string | null; provider: string; paymentReference: string | null; refund: ProcessorRefund }): Promise<Order | null> {
    const { provider, refund: reported } = report
    let existing = reported.refundId ? await this.byId(reported.refundId) : null
    if (existing && existing.provider !== provider) existing = null
    existing ??= await this.byReference(provider, reported.reference)

    const order = existing
      ? await this.orders.get(existing.orderId)
      : report.orderId
        ? await this.orders.get(report.orderId)
        : report.paymentReference
          ? await this.orders.byPaymentOrTransaction(provider, report.paymentReference)
          : null
    if (!order) {
      this.ctx.log('refunds: a processor refund matches no order', { provider, reference: reported.reference, paymentReference: report.paymentReference })
      return null
    }
    const result: RefundResult = { status: reported.status, reference: reported.reference, failureReason: reported.failureReason ?? null }

    if (existing) {
      await this.apply(existing, order, result, { requested: false })
      return this.orders.require(order.id)
    }

    const now = this.ctx.now()
    const id = newId('rf')
    const currency = reported.amount.currency.toLowerCase()
    await this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO order_refunds (id, order_id, status, amount, currency, shipping, lines_json, reason, note, provider, reference, failure_reason, idempotency_key, source, notify_customer, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, NULL, '[]', ?, NULL, ?, ?, NULL, ?, 'processor', 0, ?, ?)`
      )
      .bind(id, order.id, reported.amount.amount, currency, reported.reason ?? null, provider, reported.reference, `processor:${reported.reference}`, now, now)
      .run()
    // A concurrent delivery of the same webhook inserted it first: update that row instead.
    const row = await this.byReference(provider, reported.reference)
    if (!row) return this.orders.require(order.id)
    if (row.id === id) await this.events.record(order.id, 'refund_discovered', { refund: id, provider, reference: reported.reference, amount: reported.amount.amount })
    await this.apply(row, order, result, { requested: false })
    return this.orders.require(order.id)
  }

  /**
   * Move a refund row to what the processor said, in one batch with its consequences: the order's
   * `updated_at` (so `GET /orders?updated_since=` returns it), an event, a ledger row when money
   * went back, and the order's payment becoming `refunded` once the succeeded refunds reach what was
   * received. A terminal row never goes back to pending.
   */
  private async apply(row: OrderRefund, order: Order, result: RefundResult, opts: { requested: boolean }): Promise<void> {
    const next: RefundStatus = row.status !== 'pending' && result.status === 'pending' ? row.status : result.status
    const reference = result.reference ?? row.reference
    const failureReason = next === 'failed' ? (result.failureReason ?? row.failureReason ?? 'failed').slice(0, MAX_FAILURE_REASON) : null
    const changed = opts.requested || next !== row.status || reference !== row.reference || failureReason !== row.failureReason
    if (!changed) return
    const now = this.ctx.now()
    const received = refundTotals(order).received.amount
    const statements: DbStatement[] = [
      this.ctx.db.prepare(`UPDATE order_refunds SET status = ?, reference = ?, failure_reason = ?, updated_at = ? WHERE id = ?`).bind(next, reference, failureReason, now, row.id),
      this.ctx.db.prepare(`UPDATE orders SET updated_at = ? WHERE id = ?`).bind(now, order.id),
      this.events.statement(order.id, `refund_${next}`, { refund: row.id, provider: row.provider, reference, amount: row.amount.amount, ...(failureReason ? { failure_reason: failureReason } : {}) }),
    ]
    if (next === 'succeeded' && row.status !== 'succeeded') {
      statements.push(
        this.ctx.db
          .prepare(`INSERT INTO payments (id, order_id, provider, reference, status, amount, currency, method_label, created_at) VALUES (?, ?, ?, ?, 'refunded', ?, ?, ?, ?)`)
          .bind(newId('pay'), order.id, row.provider, reference, -row.amount.amount, row.amount.currency, order.payment.methodLabel, now),
        // Fully given back: the payment (and, as with every refund, the order) becomes refunded.
        this.ctx.db
          .prepare(
            `UPDATE orders SET status = 'refunded', payment_status = 'refunded', updated_at = ? WHERE id = ? AND payment_status = 'paid'
               AND (SELECT COALESCE(SUM(amount), 0) FROM order_refunds WHERE order_id = ? AND status = 'succeeded') >= ?`
          )
          .bind(now, order.id, order.id, received)
      )
    }
    await this.ctx.db.batch(statements)
    if (next === 'succeeded' && order.payment.status === 'paid') {
      const after = await this.orders.require(order.id)
      if (after.payment.status === 'refunded') await this.events.record(order.id, 'refunded', { provider: row.provider, reference: order.payment.reference, by: 'refunds' })
    }
  }
}
