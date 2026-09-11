import type { APIContext } from 'astro'
import { formatMoney, type StorefrontOrder } from '@skuio/storefront'
import { config } from './catalog'
import { sendEmail } from './email'
import { readEnv } from './stripe'

/**
 * What happens when an order is paid.
 *
 * This is the seam between the storefront and the rest of the business.
 * The default emails a summary to ORDER_NOTIFICATION_EMAIL. A store connected
 * to SKU.io replaces or extends this to create the sales order there.
 *
 * Stripe retries webhooks, so this must tolerate being called twice for the
 * same order — key any external write on `order.processorSessionId`.
 */
export async function onOrderCompleted(order: StorefrontOrder, context: APIContext): Promise<void> {
  const to = readEnv(context, 'ORDER_NOTIFICATION_EMAIL')
  if (!to) return

  const a = order.shippingAddress
  const text = [
    `New order ${order.reference} — ${formatMoney(order.total, config.locale)}`,
    '',
    ...order.lines.map((l) => `${l.quantity} × ${l.name} (${l.sku}) — ${formatMoney(l.total, config.locale)}`),
    '',
    `Subtotal: ${formatMoney(order.subtotal, config.locale)}`,
    `Shipping: ${order.shipping.amount ? formatMoney(order.shipping, config.locale) : 'Free'}`,
    `Total:    ${formatMoney(order.total, config.locale)}`,
    '',
    `Customer: ${order.customer.name ?? '(not given)'}`,
    `Email:    ${order.customer.email ?? '(not given)'}`,
    `Phone:    ${order.customer.phone ?? '(not given)'}`,
    '',
    'Ship to:',
    a?.name ?? '',
    a?.line1 ?? '',
    a?.line2 ?? '',
    [a?.city, a?.state, a?.postalCode].filter(Boolean).join(', '),
    a?.country ?? '',
    '',
    `Stripe session: ${order.processorSessionId}`,
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n')

  await sendEmail(context, {
    to,
    subject: `New order ${order.reference} — ${formatMoney(order.total, config.locale)}`,
    text,
  })
}
