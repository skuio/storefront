import type { Order } from '../types'
import { PaymentWebhookError, type PaymentAdapter, type PaymentContext, type PaymentEvent, type PaymentStart } from './index'

export interface PayPalPaymentOptions {
  clientId: string
  clientSecret: string
  /** The id of the webhook subscribed to /api/payments/webhook?provider=paypal (developer dashboard). */
  webhookId: string | undefined
  /** 'sandbox' (default) or 'live'. */
  environment?: 'sandbox' | 'live'
  /** Shown on PayPal's pages; defaults to the store name. */
  brandName?: string
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

const PROVIDER = 'paypal'
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'huf', 'twd'])

interface PayPalLink {
  href: string
  rel: string
}
interface PayPalCapture {
  id: string
  status: string
  amount?: { currency_code: string; value: string }
  custom_id?: string
}
interface PayPalOrder {
  id: string
  status: string
  links?: PayPalLink[]
  purchase_units?: { custom_id?: string; reference_id?: string; amount?: { currency_code: string; value: string }; payments?: { captures?: PayPalCapture[] } }[]
}

/**
 * PayPal Orders v2: the buyer approves on PayPal (PayPal balance, Venmo, Pay
 * Later, or a card as a guest), comes back to the confirmation page, and the
 * store captures. The webhook is the safety net for a buyer who never comes
 * back: it captures an approved order and reports completed captures.
 *
 * Every amount is the store's own: lines, the store discount, shipping. PayPal
 * never prices anything, so a code entered on the store's checkout page is
 * exactly what the buyer is charged.
 */
export function paypalPayments(options: PayPalPaymentOptions): PaymentAdapter {
  const base = options.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
  const http = options.fetch ?? fetch
  let token: { value: string; expires: number } | null = null

  async function accessToken(): Promise<string> {
    if (token && token.expires > Date.now() + 60_000) return token.value
    const res = await http(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 }
    return token.value
  }

  async function api<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await http(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', prefer: 'return=representation', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    if (!res.ok) throw new PayPalError(res.status, `PayPal ${method} ${path} failed: ${res.status} ${text}`, text)
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Capture an approved order. Idempotent: an already-captured order is read back instead. */
  async function capture(paypalOrderId: string): Promise<PayPalOrder> {
    try {
      return await api<PayPalOrder>('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, { 'paypal-request-id': `capture-${paypalOrderId}` })
    } catch (e) {
      if (e instanceof PayPalError && e.status === 422 && e.body.includes('ORDER_ALREADY_CAPTURED')) return api<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`)
      throw e
    }
  }

  return {
    id: PROVIDER,
    label: 'PayPal',

    async start(order, ctx): Promise<PaymentStart> {
      const currency = order.currency.toUpperCase()
      const v = (minor: number) => decimal(minor, order.currency)
      const a = order.shippingAddress
      const prefix = ctx.store.config.orders.numberPrefix
      const created = await api<PayPalOrder>(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: order.id,
              custom_id: order.id,
              invoice_id: `${prefix}${order.number}-${order.id.slice(-6)}`,
              description: `${ctx.store.config.name} order ${prefix}${order.number}`.slice(0, 127),
              amount: {
                currency_code: currency,
                value: v(order.total.amount),
                breakdown: {
                  item_total: { currency_code: currency, value: v(order.subtotal.amount) },
                  shipping: { currency_code: currency, value: v(order.shipping.amount) },
                  ...(order.tax.amount ? { tax_total: { currency_code: currency, value: v(order.tax.amount) } } : {}),
                  ...(order.discount.amount ? { discount: { currency_code: currency, value: v(order.discount.amount) } } : {}),
                },
              },
              items: order.lines.map((l) => ({
                name: l.name.slice(0, 127),
                sku: l.sku.slice(0, 127),
                quantity: String(l.quantity),
                unit_amount: { currency_code: currency, value: v(l.unitAmount.amount) },
                category: 'PHYSICAL_GOODS',
              })),
              ...(a.line1 && a.country
                ? {
                    shipping: {
                      type: 'SHIPPING',
                      name: { full_name: (a.name ?? order.customer.name ?? order.customer.email).slice(0, 300) },
                      address: {
                        address_line_1: a.line1,
                        ...(a.line2 ? { address_line_2: a.line2 } : {}),
                        ...(a.city ? { admin_area_2: a.city } : {}),
                        ...(a.state ? { admin_area_1: a.state } : {}),
                        ...(a.postalCode ? { postal_code: a.postalCode } : {}),
                        country_code: a.country,
                      },
                    },
                  }
                : {}),
            },
          ],
          payment_source: {
            paypal: {
              email_address: order.customer.email,
              experience_context: {
                brand_name: (options.brandName ?? ctx.store.config.name).slice(0, 127),
                // The store already collected and validated the address; PayPal must not let the buyer change it.
                shipping_preference: a.line1 ? 'SET_PROVIDED_ADDRESS' : 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: `${ctx.siteUrl}/checkout/success/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}&provider=${PROVIDER}`,
                cancel_url: `${ctx.siteUrl}/cart/?checkout_error=cancelled&order=${encodeURIComponent(order.id)}`,
              },
            },
          },
        },
        { 'paypal-request-id': `create-${order.id}-${order.updatedAt}` }
      )
      const approve = created.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
      if (!approve) throw new Error(`PayPal order ${created.id} has no approval link`)
      await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: created.id })
      return { kind: 'redirect', url: approve.href }
    },

    async handleWebhook(request): Promise<PaymentEvent[]> {
      if (!options.webhookId) throw new PaymentWebhookError(500, 'PAYPAL_WEBHOOK_ID is not configured')
      const raw = await request.text()
      const h = (name: string) => request.headers.get(name) ?? ''
      if (!h('paypal-transmission-id') || !h('paypal-transmission-sig')) throw new PaymentWebhookError(400, 'missing PayPal transmission headers')
      let event: { event_type?: string; resource?: Record<string, unknown> }
      try {
        event = JSON.parse(raw)
      } catch {
        throw new PaymentWebhookError(400, 'body is not JSON')
      }
      // PayPal verifies its own signature: the event must be passed back byte-for-byte as parsed JSON.
      const verdict = await api<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: options.webhookId,
        webhook_event: event,
      })
      if (verdict.verification_status !== 'SUCCESS') throw new PaymentWebhookError(400, `signature ${verdict.verification_status}`)

      const resource = event.resource ?? {}
      switch (event.event_type) {
        case 'CHECKOUT.ORDER.APPROVED': {
          // The buyer approved but may have closed the tab before returning: capture here.
          const captured = await capture(String(resource.id))
          return eventsFromOrder(captured)
        }
        case 'PAYMENT.CAPTURE.COMPLETED':
          return [paidFromCapture(resource as unknown as PayPalCapture)]
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          const c = resource as unknown as PayPalCapture
          return c.custom_id ? [{ type: 'failed', orderId: c.custom_id, provider: PROVIDER, reference: c.id, reason: event.event_type }] : [{ type: 'ignored', reason: 'capture without custom_id' }]
        }
        case 'PAYMENT.CAPTURE.REFUNDED': {
          // A refund resource links to its capture; only a full refund refunds the order.
          const capId = ((resource.links as PayPalLink[] | undefined) ?? []).find((l) => l.rel === 'up')?.href.split('/').pop()
          if (!capId) return [{ type: 'ignored', reason: 'refund without capture link' }]
          const c = await api<PayPalCapture & { status: string }>('GET', `/v2/payments/captures/${encodeURIComponent(capId)}`)
          if (c.status !== 'REFUNDED') return [{ type: 'ignored', reason: `capture ${capId} is ${c.status} (partial refund)` }]
          return [{ type: 'refunded', orderId: c.custom_id ?? null, provider: PROVIDER, reference: capId }]
        }
        default:
          return [{ type: 'ignored', reason: `unhandled event ${event.event_type}` }]
      }
    },

    async verifyReturn(params, order): Promise<PaymentEvent[]> {
      const paypalOrderId = params.get('token')
      if (!paypalOrderId) return []
      const current = await api<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`)
      if (current.purchase_units?.[0]?.custom_id !== order.id) return []
      if (current.status === 'COMPLETED') return eventsFromOrder(current)
      if (current.status !== 'APPROVED') return []
      return eventsFromOrder(await capture(paypalOrderId))
    },
  }
}

class PayPalError extends Error {
  constructor(readonly status: number, message: string, readonly body: string) {
    super(message)
  }
}

function eventsFromOrder(o: PayPalOrder): PaymentEvent[] {
  const unit = o.purchase_units?.[0]
  const capture = unit?.payments?.captures?.find((c) => c.status === 'COMPLETED')
  if (!capture) return [{ type: 'ignored', reason: `PayPal order ${o.id} is ${o.status} with no completed capture` }]
  return [paidFromCapture({ ...capture, custom_id: capture.custom_id ?? unit?.custom_id })]
}

function paidFromCapture(c: PayPalCapture): PaymentEvent {
  if (!c.custom_id) return { type: 'ignored', reason: `capture ${c.id} has no custom_id` }
  if (c.status !== 'COMPLETED') return { type: 'ignored', reason: `capture ${c.id} is ${c.status}` }
  const currency = (c.amount?.currency_code ?? 'USD').toLowerCase()
  return {
    type: 'paid',
    orderId: c.custom_id,
    provider: PROVIDER,
    reference: c.id,
    methodLabel: 'PayPal',
    paidAt: new Date().toISOString(),
    ...(c.amount ? { amount: { amount: minor(c.amount.value, currency), currency } } : {}),
  }
}

/** Minor units to PayPal's decimal string. */
export function decimal(amount: number, currency: string): string {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? String(amount) : (amount / 100).toFixed(2)
}

function minor(value: string, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(Number(value)) : Math.round(Number(value) * 100)
}
