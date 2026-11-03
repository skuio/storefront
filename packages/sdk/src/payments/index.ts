import type { Store } from '../store'
import type { Money, Order, PaymentSettlement } from '../types'

export interface PaymentContext {
  store: Store
  /** Absolute public origin, no trailing slash. */
  siteUrl: string
}

/** What `start()` hands the checkout endpoint: send the buyer somewhere, or show them instructions. */
export type PaymentStart =
  | { kind: 'redirect'; url: string }
  | { kind: 'instructions'; html: string }

/** A fact the processor reported. `applyPaymentEvents` turns it into an order change. */
export type PaymentEvent =
  | {
      type: 'paid'
      orderId: string
      provider: string
      reference: string | null
      methodLabel?: string | null
      paidAt?: string | null
      amount?: Money
      adjustments?: { discount?: Money; tax?: Money; total?: Money }
      /** What the processor captured and kept, when it reported it with the payment. */
      settlement?: PaymentSettlement
    }
  | { type: 'failed'; orderId: string; provider: string; reference: string | null; reason?: string }
  | { type: 'refunded'; orderId: string | null; provider: string; reference: string | null }
  | { type: 'ignored'; reason: string }

export type { PaymentSettlement }

export class PaymentWebhookError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'PaymentWebhookError'
    this.status = status
  }
}

/**
 * A payment processor. The store creates the order first; the adapter only
 * moves money and reports back. Nothing else in the platform knows which
 * processor is behind it.
 */
export interface PaymentAdapter {
  readonly id: string
  /** Shown to the buyer: "Card", "Bank transfer", … */
  readonly label: string
  /**
   * Take payment for a pending order. May be called more than once for the
   * same order (a buyer who comes back to pay), so it must not send mail or
   * change the order beyond opening a processor session.
   */
  start(order: Order, ctx: PaymentContext): Promise<PaymentStart>
  /**
   * Verify and decode a processor callback. Throw `PaymentWebhookError` for a
   * bad signature; return events (possibly `ignored`) for everything else.
   */
  handleWebhook(request: Request, ctx: PaymentContext): Promise<PaymentEvent[]>
  /**
   * Optional: check a return-from-processor for a completed payment, so the
   * confirmation page is right even when the webhook has not landed yet.
   */
  verifyReturn?(params: URLSearchParams, order: Order, ctx: PaymentContext): Promise<PaymentEvent[]>
  /**
   * Optional: ask the processor what it captured and kept for a paid order (its fee). The Store API
   * calls this on `GET /orders/{id}` when the fee is still unknown. Return null when the processor
   * does not know yet; throw on a processor error (the caller swallows it).
   */
  settlement?(order: Order): Promise<PaymentSettlement | null>
  /**
   * Optional: the processor's payouts (money it sent to, or pulled from, the merchant's bank) and
   * what each one is made of. The Store API serves them at `/payouts`, so an operations system can
   * post one accounting document per payout without holding processor credentials.
   */
  payouts?: PaymentPayouts
}

export type PayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled'

/**
 * What a payout line is, normalised across processors. `type` keeps the processor's own word.
 * `balance` is money that stayed in (or came from) the processor balance across a payout boundary:
 * PayPal's `carry_in` / `carry_out` lines for a partial withdrawal.
 */
export type PayoutLineCategory = 'charge' | 'refund' | 'dispute' | 'dispute_reversal' | 'fee' | 'adjustment' | 'reserve' | 'transfer' | 'balance' | 'other'

export const PAYOUT_LINE_CATEGORIES: readonly PayoutLineCategory[] = ['charge', 'refund', 'dispute', 'dispute_reversal', 'fee', 'adjustment', 'reserve', 'transfer', 'balance', 'other']

/**
 * One payout. `amount` is what reached (positive) or left (negative: a debit for a negative balance)
 * the bank, in the payout currency, integer minor units.
 */
export interface Payout {
  id: string
  provider: string
  /** The processor account that paid out (`acct_…`, PayPal payer id), so two stores sharing one account can be told apart. */
  accountId: string
  status: PayoutStatus
  amount: Money
  /** `YYYY-MM-DD`, when the bank receives it (Stripe), the withdrawal date or the balance day (PayPal). */
  arrivalDate: string | null
  /** ISO 8601 UTC, second precision (`2026-11-03T00:08:09Z`). The list is ordered by it. */
  createdAt: string
  /** `standard` / `instant` (Stripe), `withdrawal` (PayPal T0400), `balance` (a PayPal balance day) or the processor's code. */
  method: string | null
  /** A human label for the destination, e.g. `Bank ••6789`, when the processor says. */
  destinationLabel: string | null
  /**
   * How many lines `lines()` returns. Null in a list when counting would cost extra processor calls,
   * and from `get()` when counting would take more than a bounded number of calls (Stripe: over
   * 1,000 lines). Consumers page the lines to exhaustion either way.
   */
  lineCount: number | null
}

/**
 * One balance movement that a payout settles. Amounts are in the payout's currency (already
 * converted by the processor). Signs follow the processor's balance: money in is positive, money
 * out (a refund, a dispute) negative; `fee` is what the processor kept (negative when it gave a fee
 * back). Always `gross - fee = net`, and the `net` of a paid payout's lines sums to its `amount`.
 */
export interface PayoutLine {
  id: string
  /** The processor's own type (Stripe `type`, PayPal T-code). */
  type: string
  category: PayoutLineCategory
  /** The processor object behind the line: `ch_…` / `re_…` / `du_…` (Stripe), the transaction id (PayPal). */
  sourceId: string | null
  /** The store order the money belongs to, when the processor carries it (charge metadata / PayPal custom id). */
  orderId: string | null
  orderNumber: string | null
  /** The store's `payment.reference` of that order (`pi_…`, PayPal capture id), when known. */
  paymentReference: string | null
  gross: Money
  fee: Money
  net: Money
  feeDetails: PayoutFeeDetail[]
  createdAt: string
  /** `YYYY-MM-DD` the funds became available (Stripe); null when the processor has no such date. */
  availableOn: string | null
  description: string | null
}

export interface PayoutFeeDetail {
  type: string
  /** Integer minor units in the payout currency. */
  amount: number
  description: string | null
}

/** A position in the payout list: strictly after this `(createdAt, id)`. */
export interface PayoutPosition {
  createdAt: string
  id: string
}

export interface PayoutListParams {
  /** ISO 8601 UTC; payouts created at or after it. */
  createdSince: string
  /** Strictly after this position (keyset paging); null for the first page. */
  after: PayoutPosition | null
  limit: number
  /**
   * ISO 8601 UTC; when set, only payouts created at or before it. The merged list passes one
   * completeness cutoff to every provider (and keeps it for every page) so a processor that reports
   * late is never skipped by a cursor another processor moved past.
   */
  until?: string | null
  /**
   * The processor-specific payout mode the caller asked for (`<provider>_mode` on the Store API,
   * e.g. `paypal_mode=balance`); null or omitted for the adapter's default. An adapter without modes
   * ignores it; one with modes throws `invalid` for a value it does not know.
   */
  mode?: string | null
}

/** Options `get()` and `lines()` accept beside the id: the same `mode` as the list (ids are self-describing, so it is only validated). */
export interface PayoutLookupOptions {
  mode?: string | null
}

/** PayPal Transaction Search's documented reporting lag (up to three hours): its default `reportingLagMs`. */
export const PAYOUT_COMPLETENESS_LAG_MS = 3 * 3_600_000

/** True when `p` is at or before `until` (no bound when null). */
export function isWithin(p: { createdAt: string }, until: string | null | undefined): boolean {
  return !until || p.createdAt <= until
}

export interface PayoutListResult {
  /** Ascending by `(createdAt, id)`. */
  payouts: Payout[]
  hasMore: boolean
}

export interface PayoutLinePage {
  lines: PayoutLine[]
  /** Opaque, adapter-issued; null on the last page. */
  nextCursor: string | null
}

/** The payout capability of a `PaymentAdapter`. Throw `ProcessorPermissionError` when the processor refuses. */
export interface PaymentPayouts {
  /**
   * How far behind real time this processor's payout data may be, in ms (PayPal Transaction Search:
   * three hours by default, `reportingLagMs` when configured). Omitted means none (Stripe). A merged
   * list stops at now minus the largest lag among the providers it merges.
   */
  readonly reportingLagMs?: number
  list(params: PayoutListParams): Promise<PayoutListResult>
  /** One payout with `lineCount` filled; null when the processor has no such payout. */
  get(id: string, options?: PayoutLookupOptions): Promise<Payout | null>
  /** Throw `notFound` (StoreError) when the payout does not exist. */
  lines(payoutId: string, params: { cursor: string | null; limit: number } & PayoutLookupOptions): Promise<PayoutLinePage>
  /**
   * Optional: the processor account this adapter pays out from (the same id its payouts carry), when
   * it can be read cheaply (a cached id, or one already learned this request); null when it cannot.
   * The list response reports it as `accounts`, so a consumer notices an account switch even when
   * there are no new payouts. Must not throw for a missing permission: return null.
   */
  account?(): Promise<string | null>
}

/**
 * What the built-in adapters name in a 424: Stripe restricted-key permissions, PayPal's app feature,
 * or PayPal's client id and secret themselves.
 */
export type ProcessorPermission =
  | 'Payouts: Read'
  | 'Balance: Read'
  | 'Balance transaction sources: Read'
  | 'Account: Read'
  | 'Transaction search'
  | 'API credentials'

/**
 * The processor answered 401/403: the store's key may not read what was asked. The Store API turns
 * it into HTTP 424 `processor_permission_missing` naming the permission to grant.
 */
export class ProcessorPermissionError extends Error {
  readonly provider: string
  /** One of `ProcessorPermission` for the built-in adapters; a custom adapter may name its own. */
  readonly permission: ProcessorPermission | (string & {})
  constructor(provider: string, permission: string, message: string) {
    super(message)
    this.name = 'ProcessorPermissionError'
    this.provider = provider
    this.permission = permission
  }
}

/** Unix seconds or a Date to `2026-11-03T00:08:09Z`. */
export function isoSeconds(value: number | Date): string {
  const d = typeof value === 'number' ? new Date(value * 1000) : value
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** True when `p` comes strictly after `after` in `(createdAt, id)` order. */
export function isAfter(p: PayoutPosition, after: PayoutPosition | null): boolean {
  if (!after) return true
  if (p.createdAt !== after.createdAt) return p.createdAt > after.createdAt
  return p.id > after.id
}

export function comparePayouts(a: PayoutPosition, b: PayoutPosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Apply processor events to the store. Idempotent, like the order methods underneath. */
export async function applyPaymentEvents(store: Store, events: PaymentEvent[]): Promise<Order[]> {
  const touched: Order[] = []
  for (const event of events) {
    switch (event.type) {
      case 'paid':
        touched.push(
          await store.orders.markPaid(event.orderId, {
            provider: event.provider,
            reference: event.reference,
            methodLabel: event.methodLabel ?? null,
            paidAt: event.paidAt ?? null,
            ...(event.amount ? { amount: event.amount } : {}),
            ...(event.adjustments ? { adjustments: event.adjustments } : {}),
            ...(event.settlement ? { settlement: event.settlement } : {}),
          })
        )
        break
      case 'failed':
        touched.push(await store.orders.setPaymentStatus(event.orderId, { status: 'failed', provider: event.provider, reference: event.reference }))
        break
      case 'refunded': {
        const id = event.orderId ?? (event.reference ? (await store.orders.byPaymentReference(event.provider, event.reference))?.id : null)
        if (id) touched.push(await store.orders.setPaymentStatus(id, { status: 'refunded', provider: event.provider, reference: event.reference }))
        break
      }
      case 'ignored':
        break
    }
  }
  return touched
}
