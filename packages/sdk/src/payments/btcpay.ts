import type { Order } from '../types'
import { PaymentWebhookError, type PaymentAdapter, type PaymentContext, type PaymentEvent, type PaymentStart } from './index'

export interface BtcPayPaymentOptions {
  /** BTCPay Server origin, e.g. https://btcpay.example.com (self-hosted or a host such as Voltage). */
  serverUrl: string
  storeId: string
  /** Greenfield API key with btcpay.store.cancreateinvoice and btcpay.store.canviewinvoices. */
  apiKey: string
  /** Secret of the store webhook pointed at /api/payments/webhook?provider=btcpay. */
  webhookSecret: string | undefined
  /** BTCPay's speed policy: how many confirmations make an on-chain payment settled. Default MediumSpeed (1 conf). */
  speedPolicy?: 'HighSpeed' | 'MediumSpeed' | 'LowMediumSpeed' | 'LowSpeed'
  /** Shown to the buyer; default "Bitcoin / Lightning". */
  label?: string
  fetch?: typeof fetch
}

const PROVIDER = 'btcpay'

interface Invoice {
  id: string
  status: 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled'
  amount: string
  currency: string
  checkoutLink: string
  metadata?: { orderId?: string }
}

/**
 * Bitcoin on-chain and Lightning through BTCPay Server's Greenfield API. The
 * invoice is priced in the store currency from the order total — discount
 * and shipping included — and BTCPay converts at its rate. Funds settle to the
 * merchant's own wallet; there are no chargebacks, and refunds are issued
 * from BTCPay (they are not reported back here).
 *
 * The webhook payload is only a nudge: the adapter reads the invoice back
 * from the API before it believes anything, so a forged or replayed body
 * cannot mark an order paid even if the HMAC secret leaked.
 */
export function btcpayPayments(options: BtcPayPaymentOptions): PaymentAdapter {
  const http = options.fetch ?? fetch
  const server = options.serverUrl.replace(/\/+$/, '')
  const storePath = `/api/v1/stores/${encodeURIComponent(options.storeId)}`

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await http(`${server}${path}`, {
      method,
      headers: { authorization: `token ${options.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`BTCPay ${method} ${path} failed: ${res.status} ${text}`)
    return JSON.parse(text) as T
  }

  function eventsFromInvoice(invoice: Invoice, expectedOrderId?: string): PaymentEvent[] {
    const orderId = invoice.metadata?.orderId
    if (!orderId) return [{ type: 'ignored', reason: `invoice ${invoice.id} has no orderId` }]
    if (expectedOrderId && orderId !== expectedOrderId) return [{ type: 'ignored', reason: `invoice ${invoice.id} belongs to another order` }]
    if (invoice.status === 'Settled') {
      const currency = invoice.currency.toLowerCase()
      return [
        {
          type: 'paid',
          orderId,
          provider: PROVIDER,
          reference: invoice.id,
          methodLabel: 'Bitcoin',
          paidAt: new Date().toISOString(),
          amount: { amount: Math.round(Number(invoice.amount) * 100), currency },
        },
      ]
    }
    if (invoice.status === 'Invalid') return [{ type: 'failed', orderId, provider: PROVIDER, reference: invoice.id, reason: 'invoice invalid' }]
    // New / Processing (seen, unconfirmed) / Expired: nothing to record; an unpaid order expires on its own.
    return [{ type: 'ignored', reason: `invoice ${invoice.id} is ${invoice.status}` }]
  }

  return {
    id: PROVIDER,
    label: options.label ?? 'Bitcoin / Lightning',

    async start(order: Order, ctx: PaymentContext): Promise<PaymentStart> {
      const prefix = ctx.store.config.orders.numberPrefix
      const invoice = await api<Invoice>('POST', `${storePath}/invoices`, {
        amount: (order.total.amount / 100).toFixed(2),
        currency: order.currency.toUpperCase(),
        metadata: {
          orderId: order.id,
          orderNumber: `${prefix}${order.number}`,
          buyerEmail: order.customer.email,
          itemDesc: order.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ').slice(0, 200),
        },
        checkout: {
          speedPolicy: options.speedPolicy ?? 'MediumSpeed',
          redirectURL: `${ctx.siteUrl}/checkout/success/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}&provider=${PROVIDER}`,
          redirectAutomatically: true,
        },
      })
      await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: invoice.id })
      return { kind: 'redirect', url: invoice.checkoutLink }
    },

    async handleWebhook(request): Promise<PaymentEvent[]> {
      if (!options.webhookSecret) throw new PaymentWebhookError(500, 'BTCPAY_WEBHOOK_SECRET is not configured')
      const raw = await request.text()
      const sig = request.headers.get('btcpay-sig') ?? ''
      if (!(await validSignature(options.webhookSecret, raw, sig))) throw new PaymentWebhookError(400, 'invalid BTCPay-Sig')
      let body: { type?: string; invoiceId?: string; storeId?: string }
      try {
        body = JSON.parse(raw)
      } catch {
        throw new PaymentWebhookError(400, 'body is not JSON')
      }
      if (!body.invoiceId || !body.type?.startsWith('Invoice')) return [{ type: 'ignored', reason: `unhandled event ${body.type}` }]
      if (body.storeId && body.storeId !== options.storeId) return [{ type: 'ignored', reason: `event for store ${body.storeId}` }]
      return eventsFromInvoice(await api<Invoice>('GET', `${storePath}/invoices/${encodeURIComponent(body.invoiceId)}`))
    },

    async verifyReturn(_params, order): Promise<PaymentEvent[]> {
      const invoices = await api<Invoice[]>('GET', `${storePath}/invoices?orderId=${encodeURIComponent(order.id)}`)
      const settled = invoices.find((i) => i.status === 'Settled' && i.metadata?.orderId === order.id)
      return settled ? eventsFromInvoice(settled, order.id) : []
    },
  }
}

/** BTCPay-Sig: "sha256=" + hex HMAC-SHA256 of the raw body. Compared in constant time. */
export async function validSignature(secret: string, raw: string, header: string): Promise<boolean> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)))
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i)
  return diff === 0
}
