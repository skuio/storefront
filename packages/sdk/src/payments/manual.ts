import { escapeHtml } from '../mail/templates'
import { formatMoney } from '../money'
import type { Order } from '../types'
import type { PaymentAdapter, PaymentContext, PaymentStart } from './index'

export interface ManualPaymentOptions {
  /** Shown on the pending page and in the order's `method_label`. */
  label?: string
  /** Instructions HTML; receives the order so it can quote the number and total. */
  instructions?: (order: Order, ctx: PaymentContext) => string
}

/**
 * Pay later: the order is placed and stays `pending_payment` until the
 * operations system marks it paid through the Store API (PATCH payment).
 * Proves the pipeline needs no processor at all. `start()` is pure — the
 * checkout endpoint sends the "order received" email once, and the pending
 * page may call `start()` again to re-render the instructions.
 */
export function manualPayments(options: ManualPaymentOptions = {}): PaymentAdapter {
  const label = options.label ?? 'Pay by invoice'
  return {
    id: 'manual',
    label,
    async start(order, ctx): Promise<PaymentStart> {
      const html =
        options.instructions?.(order, ctx) ??
        `<p>Your order <strong>${escapeHtml(ctx.store.config.orders.numberPrefix + order.number)}</strong> for <strong>${escapeHtml(
          formatMoney(order.total, ctx.store.config.locale)
        )}</strong> has been received.</p><p>We will contact you at <strong>${escapeHtml(order.customer.email)}</strong> with payment instructions. Nothing ships until payment is confirmed.</p>`
      return { kind: 'instructions', html }
    },
    async handleWebhook() {
      return [{ type: 'ignored', reason: 'manual payments have no webhook' }]
    },
  }
}
