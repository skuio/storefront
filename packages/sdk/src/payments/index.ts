import type { Store } from '../store'
import type { Money, Order } from '../types'

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
    }
  | { type: 'failed'; orderId: string; provider: string; reference: string | null; reason?: string }
  | { type: 'refunded'; orderId: string | null; provider: string; reference: string | null }
  | { type: 'ignored'; reason: string }

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
