import type { Address, Money, Order, PaymentSettlement } from '../types'
import type { Quote } from '../store/checkout'
import { decodeKeysetCursor, encodeKeysetCursor } from '../store/cursor'
import { invalid, notFound } from '../store/errors'
import {
  comparePayouts, isAfter, isoSeconds, isWithin, PAYOUT_COMPLETENESS_LAG_MS, PaymentWebhookError, ProcessorPermissionError,
  type PaymentAdapter, type PaymentContext, type PaymentEvent, type PaymentPayouts, type PaymentStart, type Payout,
  type PayoutAssignments, type PayoutLine, type PayoutLineCategory,
} from './index'

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
  /** Injected for tests; the clock payouts are listed up to. */
  now?: () => Date
  /**
   * How far behind real time Transaction Search is trusted, in ms (default `PAYPAL_REPORTING_LAG_MS`,
   * three hours). Payouts read only transactions older than this, so a withdrawal shows up that long after it.
   */
  reportingLagMs?: number
}

const PROVIDER = 'paypal'
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'huf', 'twd'])

interface PayPalLink {
  href: string
  rel: string
}
interface PayPalMoney {
  currency_code: string
  value: string
}
interface PayPalCapture {
  id: string
  status: string
  amount?: PayPalMoney
  custom_id?: string
  /** What PayPal kept and what the merchant receives (present on completed captures). */
  seller_receivable_breakdown?: { gross_amount?: PayPalMoney; paypal_fee?: PayPalMoney; net_amount?: PayPalMoney }
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
    if (!res.ok) {
      const text = await res.text()
      if (res.status === 401 || res.status === 403) throw new PayPalAuthError(res.status, `PayPal auth failed: ${res.status} ${text}`)
      throw new Error(`PayPal auth failed: ${res.status} ${text}`)
    }
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
          // An express order (paypalExpress) has no store order until the buyer's browser completes it,
          // and that path captures. Capturing it here would take money with nothing to ship.
          const units = (resource.purchase_units as { custom_id?: string }[] | undefined) ?? []
          if (!units[0]?.custom_id) return [{ type: 'ignored', reason: `PayPal order ${String(resource.id)} is not linked to a store order` }]
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

    async settlement(order): Promise<PaymentSettlement | null> {
      const captureId = order.payment.reference
      if (!captureId) return null
      return settlementOf(await api<PayPalCapture>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`))
    },

    payouts: paypalPayouts({ clientId: options.clientId, api, now: options.now, reportingLagMs: options.reportingLagMs }),
  }
}

/**
 * What PayPal captured and kept, from a capture's `seller_receivable_breakdown`. The fee and net are
 * each in their own currency (PayPal's receivable side). Null for a capture that is not completed.
 */
export function settlementOf(c: PayPalCapture): PaymentSettlement | null {
  if (c.status !== 'COMPLETED' && c.status !== 'REFUNDED' && c.status !== 'PARTIALLY_REFUNDED') return null
  const b = c.seller_receivable_breakdown
  const gross = b?.gross_amount ?? c.amount
  return {
    amountReceived: gross ? paypalMoney(gross) : null,
    fee: b?.paypal_fee ? paypalMoney(b.paypal_fee) : null,
    net: b?.net_amount ? paypalMoney(b.net_amount) : null,
    transactionId: c.id,
  }
}

function paypalMoney(m: PayPalMoney): Money {
  const currency = m.currency_code.toLowerCase()
  return { amount: minor(m.value, currency), currency }
}

class PayPalError extends Error {
  constructor(readonly status: number, message: string, readonly body: string) {
    super(message)
  }
}

/** The OAuth token endpoint refused the client id and secret (401/403). */
export class PayPalAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'PayPalAuthError'
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
  const settlement = settlementOf(c)
  return {
    type: 'paid',
    orderId: c.custom_id,
    provider: PROVIDER,
    reference: c.id,
    methodLabel: 'PayPal',
    paidAt: new Date().toISOString(),
    ...(c.amount ? { amount: { amount: minor(c.amount.value, currency), currency } } : {}),
    ...(settlement ? { settlement } : {}),
  }
}

/** Minor units to PayPal's decimal string. */
export function decimal(amount: number, currency: string): string {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? String(amount) : (amount / 100).toFixed(2)
}

function minor(value: string, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(Number(value)) : Math.round(Number(value) * 100)
}


// ── Express checkout ────────────────────────────────────────────────────────────────────────
//
// The buyer starts with PayPal (or Venmo / Pay Later) before any store form: PayPal supplies
// the shipping address and contact from their account, so there is nothing to type. The flow,
// driven by PayPal's JS SDK buttons and three store routes:
//
//   1. create   — a PayPal order priced from the store's quote (items, code, default shipping),
//                 with shipping_preference GET_FROM_FILE. No store order exists yet.
//   2. reprice  — when the buyer picks or changes the address in PayPal's window, the store
//                 re-quotes for that country and PATCHes the amount (or refuses the country).
//   3. complete — after approval: read the buyer back, create the store order from it, link the
//                 PayPal order to it (custom_id), capture, and mark the order paid.
//
// The store prices everything; PayPal never does. A PayPal order that is approved but never
// completed is never captured (the webhook skips orders without a custom_id).

export interface ExpressBuyer {
  paypalOrderId: string
  status: string
  email: string
  name: string | null
  phone: string | null
  shippingAddress: Address
  /** What the buyer approved, minor units. */
  amount: { amount: number; currency: string }
}

export interface PayPalExpress {
  create(quote: Quote, opts: { brandName: string }): Promise<string>
  reprice(paypalOrderId: string, quote: Quote): Promise<void>
  buyer(paypalOrderId: string): Promise<ExpressBuyer>
  attach(paypalOrderId: string, order: Order, invoicePrefix: string): Promise<void>
  capture(paypalOrderId: string): Promise<PaymentEvent[]>
}

interface PayPalOrderDetail extends PayPalOrder {
  payer?: { email_address?: string; name?: { given_name?: string; surname?: string }; phone?: { phone_number?: { national_number?: string } } }
  purchase_units?: (NonNullable<PayPalOrder['purchase_units']>[number] & {
    shipping?: { name?: { full_name?: string }; address?: { address_line_1?: string; address_line_2?: string; admin_area_2?: string; admin_area_1?: string; postal_code?: string; country_code?: string } }
  })[]
}

export function paypalExpress(options: PayPalPaymentOptions): PayPalExpress {
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
    if (!res.ok) {
      const text = await res.text()
      if (res.status === 401 || res.status === 403) throw new PayPalAuthError(res.status, `PayPal auth failed: ${res.status} ${text}`)
      throw new Error(`PayPal auth failed: ${res.status} ${text}`)
    }
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
  const path = (id: string) => `/v2/checkout/orders/${encodeURIComponent(id)}`
  const unit = "/purchase_units/@reference_id=='default'"

  return {
    async create(quote, opts) {
      const created = await api<PayPalOrder>('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: 'default', amount: expressAmount(quote), items: expressItems(quote) }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: opts.brandName.slice(0, 127),
              // PayPal supplies the address from the buyer's account — the whole point of express.
              shipping_preference: 'GET_FROM_FILE',
              user_action: 'PAY_NOW',
            },
          },
        },
      })
      return created.id
    },

    async reprice(paypalOrderId, quote) {
      await api('PATCH', path(paypalOrderId), [
        { op: 'replace', path: `${unit}/amount`, value: expressAmount(quote) },
        { op: 'replace', path: `${unit}/items`, value: expressItems(quote) },
      ])
    },

    async buyer(paypalOrderId) {
      const o = await api<PayPalOrderDetail>('GET', path(paypalOrderId))
      const u = o.purchase_units?.[0]
      const a = u?.shipping?.address ?? {}
      const given = [o.payer?.name?.given_name, o.payer?.name?.surname].filter(Boolean).join(' ') || null
      const currency = (u?.amount?.currency_code ?? 'USD').toLowerCase()
      return {
        paypalOrderId: o.id,
        status: o.status,
        email: o.payer?.email_address ?? '',
        name: given,
        phone: o.payer?.phone?.phone_number?.national_number ?? null,
        shippingAddress: {
          name: u?.shipping?.name?.full_name ?? given ?? undefined,
          line1: a.address_line_1,
          line2: a.address_line_2,
          city: a.admin_area_2,
          state: a.admin_area_1,
          postalCode: a.postal_code,
          country: a.country_code,
        },
        amount: { amount: minor(u?.amount?.value ?? '0', currency), currency },
      }
    },

    async attach(paypalOrderId, order, invoicePrefix) {
      await api('PATCH', path(paypalOrderId), [
        { op: 'add', path: `${unit}/custom_id`, value: order.id },
        { op: 'add', path: `${unit}/invoice_id`, value: `${invoicePrefix}${order.number}-${order.id.slice(-6)}` },
      ])
    },

    async capture(paypalOrderId) {
      let captured: PayPalOrder
      try {
        captured = await api<PayPalOrder>('POST', `${path(paypalOrderId)}/capture`, {}, { 'paypal-request-id': `capture-${paypalOrderId}` })
      } catch (e) {
        if (e instanceof PayPalError && e.status === 422 && e.body.includes('ORDER_ALREADY_CAPTURED')) captured = await api<PayPalOrder>('GET', path(paypalOrderId))
        else throw e
      }
      return eventsFromOrder(captured)
    },
  }
}

function expressAmount(q: Quote) {
  const c = q.currency.toUpperCase()
  const v = (n: number) => decimal(n, q.currency)
  return {
    currency_code: c,
    value: v(q.total),
    breakdown: {
      item_total: { currency_code: c, value: v(q.subtotal) },
      shipping: { currency_code: c, value: v(q.shipping) },
      ...(q.discount ? { discount: { currency_code: c, value: v(q.discount) } } : {}),
    },
  }
}

function expressItems(q: Quote) {
  const c = q.currency.toUpperCase()
  return q.lines.map((l) => ({
    name: l.name.slice(0, 127),
    sku: l.sku.slice(0, 127),
    quantity: String(l.quantity),
    unit_amount: { currency_code: c, value: decimal(l.unitAmount, q.currency) },
    category: 'PHYSICAL_GOODS',
  }))
}


// ── Payouts ─────────────────────────────────────────────────────────────────────────────────
//
// PayPal has no payout object: money sits in the PayPal balance until a withdrawal (T04xx) moves it
// to the bank. Read through Transaction Search, it serves payouts in one of two modes:
//
//   withdrawal (default) — a payout IS a withdrawal; its lines are the balance-affecting transactions
//     in its currency after the previous withdrawal, up to it, plus `carry_in` / `carry_out` balance
//     lines when PayPal's `ending_balance` shows the withdrawal left money behind (a partial one).
//   balance — the merchant books the PayPal balance as a bank account: one payout per UTC day and
//     currency, made of that day's movements, withdrawals left out (they are transfers the merchant
//     books between PayPal and the bank).
//
// Either way a transaction is grouped by when its money reached the balance: its initiation, or for
// a payment that waited to clear (an eCheck) its settlement (`isPayPalDelayedSettlement`). The app needs the
// "Transaction search" feature (scope https://uri.paypal.com/services/reporting/search/read).

/** Transaction Search accepts at most 31 days per request and three years of history. */
const WINDOW_MS = 31 * 86_400_000 - 1000
const HISTORY_MS = 3 * 365 * 86_400_000
const MAX_WINDOWS = 37
const DAY_MS = 86_400_000
const PERMISSION = 'Transaction search'
/** The client id and secret themselves were refused (OAuth 401/403). */
const CREDENTIALS_PERMISSION = 'API credentials'
/** PayPal: Transaction Search can lag real time by up to three hours. Payouts read only older data. */
export const PAYPAL_REPORTING_LAG_MS = PAYOUT_COMPLETENESS_LAG_MS
/** The smallest window a too-large result set is split down to. */
const MIN_SPLIT_MS = 3_600_000
/**
 * The longest a delayed payment (an eCheck clears in 3–5 business days) may take from initiation to
 * settlement and still be grouped by its settlement. Reads reach back this far before a payout.
 */
export const PAYPAL_SETTLEMENT_DELAY_MAX_MS = 14 * DAY_MS
/** A bank-funded payment cleared at least this long after it started was an eCheck, not an instant transfer. */
const BANK_DELAY_MIN_MS = DAY_MS
const ECHECK = /E_?CHECK/i

export type PayPalPayoutMode = 'withdrawal' | 'balance'
export const PAYPAL_PAYOUT_MODES: readonly PayPalPayoutMode[] = ['withdrawal', 'balance']

/** Balance-mode payout ids: `day-2026-11-02-USD`. PayPal transaction ids never start with `day-`. */
const DAY_ID = /^day-(\d{4}-\d{2}-\d{2})-([A-Z]{3})$/

export interface PayPalTransaction {
  transaction_info: {
    transaction_id: string
    transaction_event_code: string
    transaction_initiation_date: string
    transaction_updated_date?: string
    transaction_amount: PayPalMoney
    fee_amount?: PayPalMoney
    transaction_status?: string
    custom_field?: string
    invoice_id?: string
    paypal_reference_id?: string
    transaction_subject?: string
    transaction_note?: string
    /** The account balance in this currency after the transaction. PayPal leaves it empty when the search used a filter. */
    ending_balance?: PayPalMoney
    /** What funded a payment: `PAYPAL`, `CREDIT_CARD`, `BANK`, … (PayPal's own values, not an enum). */
    instrument_type?: string
    instrument_sub_type?: string
  }
}

interface PayPalSearchPage {
  transaction_details?: PayPalTransaction[]
  account_number?: string
  page?: number
  total_pages?: number
}

/** PayPal T-code → line category. Exported for tests. */
export function paypalLineCategory(code: string): PayPalLineCategoryOrPayout {
  const n = Number(code.replace(/^T/, ''))
  if (!Number.isFinite(n)) return 'other'
  if (n >= 400 && n <= 499) return 'payout'
  if ((n >= 0 && n <= 13) || n === 700) return 'charge'
  if (n === 1107) return 'refund'
  if (n === 1106 || n === 1201) return 'dispute'
  if (n === 1202) return 'dispute_reversal'
  // T1108 fee reversal, T1109 fee refund: PayPal gives a fee back.
  if ((n >= 100 && n <= 199) || n === 1108 || n === 1109) return 'fee'
  // T1105 releases a general account hold; T15xx are holds.
  if (n === 1105 || (n >= 1500 && n <= 1599)) return 'reserve'
  if ((n >= 200 && n <= 299) || (n >= 1900 && n <= 1999)) return 'adjustment'
  // T1101: PayPal reversing a withdrawal (the bank returned it) — money back from the bank.
  if ((n >= 300 && n <= 399) || n === 1101) return 'transfer'
  return 'other'
}
export type PayPalLineCategoryOrPayout = PayoutLineCategory | 'payout'

/** T13xx are authorization events (authorize, reauthorize, void): they never move the balance. */
export function isPayPalBalanceMovement(code: string): boolean {
  const n = Number(code.replace(/^T/, ''))
  return !(n >= 1300 && n <= 1399)
}

/**
 * A payment whose money reached the balance after it started: completed (`S`) now, an incoming
 * payment (T00xx), at most `PAYPAL_SETTLEMENT_DELAY_MAX_MS` between `transaction_initiation_date`
 * and `transaction_updated_date`, and funded by an eCheck — `instrument_type` or
 * `instrument_sub_type` says ECHECK, or `instrument_type` is `BANK` and it cleared at least a day
 * after it started (an instant bank transfer completes at once). Transaction Search has no field
 * that says "this was pending", so anything else keeps its initiation date. The caller also keeps
 * the initiation date for a payment another transaction references (a refund or dispute can move
 * `transaction_updated_date` too). Exported for tests.
 */
export function isPayPalDelayedSettlement(t: PayPalTransaction): boolean {
  const info = t.transaction_info
  if ((info.transaction_status ?? 'S') !== 'S' || !info.transaction_updated_date) return false
  if (paypalLineCategory(info.transaction_event_code) !== 'charge') return false
  const delay = paypalInstant(info.transaction_updated_date) - paypalInstant(info.transaction_initiation_date)
  if (!(delay > 0) || delay > PAYPAL_SETTLEMENT_DELAY_MAX_MS) return false
  if (ECHECK.test(info.instrument_type ?? '') || ECHECK.test(info.instrument_sub_type ?? '')) return true
  return (info.instrument_type ?? '').toUpperCase() === 'BANK' && delay >= BANK_DELAY_MIN_MS
}

/** PayPal's timestamp (`2026-10-27T12:53:15+0000`, fractional seconds allowed) at full precision, in ms. */
function paypalInstant(value: string): number {
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
}

/** `2026-10-27T12:53:15+0000` → `2026-10-27T12:53:15Z` (what the API shows; grouping uses `paypalInstant`). */
function paypalTime(value: string): string {
  const t = paypalInstant(value)
  return Number.isNaN(t) ? value : isoSeconds(new Date(t))
}

const instantOf = (t: PayPalTransaction) => paypalInstant(t.transaction_info.transaction_initiation_date)
/** `transaction_updated_date` in ms; NaN when PayPal sent none. */
const updatedOf = (t: PayPalTransaction) => (t.transaction_info.transaction_updated_date ? paypalInstant(t.transaction_info.transaction_updated_date) : NaN)
/** What the store records for a transaction fixed to a payout: its id and initiation time with ms. */
const assignmentRow = (t: PayPalTransaction) => ({ transactionId: t.transaction_info.transaction_id, occurredAt: new Date(instantOf(t)).toISOString() })
const idOf = (t: PayPalTransaction) => t.transaction_info.transaction_id
const byId = (a: PayPalTransaction, b: PayPalTransaction) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0)

/** Transaction statuses whose amount moved the balance: success, and success later reversed. */
const MOVED_BALANCE = new Set(['S', 'V'])
const isWithdrawal = (t: PayPalTransaction) => paypalLineCategory(t.transaction_info.transaction_event_code) === 'payout'
/** A withdrawal that took money out of the balance (completed or still on its way). */
const isBoundary = (t: PayPalTransaction) => isWithdrawal(t) && ['S', 'P'].includes(t.transaction_info.transaction_status ?? 'S')
const currencyOf = (t: PayPalTransaction) => t.transaction_info.transaction_amount.currency_code.toLowerCase()
/** Moved the balance: completed (or completed and later reversed), and not an authorization event. */
const movedBalance = (t: PayPalTransaction) =>
  isPayPalBalanceMovement(t.transaction_info.transaction_event_code) && MOVED_BALANCE.has(t.transaction_info.transaction_status ?? 'S')
/** A balance-mode line: every balance movement except withdrawals (any status) and withdrawal reversals (T1101). */
const isBalanceDayLine = (t: PayPalTransaction) => !isWithdrawal(t) && t.transaction_info.transaction_event_code !== 'T1101' && movedBalance(t)

/** gross − fee: the transaction amount plus PayPal's (negative) fee amount, in minor units. */
function netOf(t: PayPalTransaction): number {
  const info = t.transaction_info
  const currency = currencyOf(t)
  return minor(info.transaction_amount.value, currency) + (info.fee_amount ? minor(info.fee_amount.value, currency) : 0)
}

/** The balance after `t` in `currency`, minor units; null when PayPal left `ending_balance` empty or in another currency. */
function balanceAfter(t: PayPalTransaction, currency: string): number | null {
  const b = t.transaction_info.ending_balance
  if (!b?.value || b.currency_code?.toLowerCase() !== currency) return null
  const value = minor(b.value, currency)
  return Number.isFinite(value) ? value : null
}

const utcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function withdrawalStatus(status: string | undefined): Payout['status'] {
  switch (status) {
    case 'P':
      return 'in_transit'
    case 'V':
      return 'canceled'
    case 'D':
    case 'F':
      return 'failed'
    default:
      return 'paid'
  }
}

function payoutMode(mode: string | null | undefined): PayPalPayoutMode {
  if (mode === null || mode === undefined || mode === '') return 'withdrawal'
  if (!(PAYPAL_PAYOUT_MODES as readonly string[]).includes(mode)) throw invalid('Invalid query', { paypal_mode: `must be one of ${PAYPAL_PAYOUT_MODES.join(', ')}` })
  return mode as PayPalPayoutMode
}

/** A partial withdrawal's balance lines: what was left before it and what it left behind. */
interface Carry {
  carryIn: { amount: number; source: PayPalTransaction } | null
  carryOut: { amount: number; source: PayPalTransaction } | null
}

/**
 * The payout capability over PayPal Transaction Search. `paypalPayments` includes it; `api` is that
 * adapter's authenticated request function.
 */
export function paypalPayouts(deps: {
  clientId: string
  api: <T>(method: string, path: string) => Promise<T>
  now?: () => Date
  reportingLagMs?: number
}): PaymentPayouts {
  const now = () => deps.now?.() ?? new Date()
  /** The newest moment Transaction Search is trusted to be complete up to. */
  const settled = () => now().getTime() - (deps.reportingLagMs ?? PAYPAL_REPORTING_LAG_MS)
  const historyFloor = () => now().getTime() - HISTORY_MS + DAY_MS
  let account: string | null = null
  /** The `account_number` Transaction Search reports: the merchant's payer id. */
  let searchAccount: string | null = null
  /** When each transaction's money reached the balance, as last worked out by `chronological`. */
  const settledAtCache = new WeakMap<PayPalTransaction, number>()
  const settledAt = (t: PayPalTransaction) => settledAtCache.get(t) ?? instantOf(t)

  /** `deps.api`, with refused credentials turned into the Store API's 424. */
  async function call<T>(method: string, path: string): Promise<T> {
    try {
      return await deps.api<T>(method, path)
    } catch (e) {
      if (e instanceof PayPalAuthError) {
        throw new ProcessorPermissionError(PROVIDER, CREDENTIALS_PERMISSION, `PayPal refused the store's client id and secret (${e.status}): check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are the Live app's.`)
      }
      throw e
    }
  }

  /**
   * Every transaction in [start, end] (both ends inclusive), capped at the settled watermark. A window
   * PayPal refuses as RESULTSET_TOO_LARGE is halved (down to an hour) into [start, mid] and [mid, end]:
   * the halves overlap at `mid`, so a transaction there (or a fraction of a second after it) is never
   * lost, and `chronological` drops the duplicate by transaction id.
   */
  async function search(start: number, end: number, extra: Record<string, string> = {}): Promise<PayPalTransaction[]> {
    end = Math.min(end, settled())
    if (start > end) return []
    try {
      return await searchPages(start, end, extra)
    } catch (e) {
      if (!(e instanceof PayPalError && /RESULTSET_TOO_LARGE/.test(e.body)) || end - start <= MIN_SPLIT_MS) throw e
      const mid = start + Math.floor((end - start) / 2000) * 1000
      return [...(await search(start, mid, extra)), ...(await search(mid, end, extra))]
    }
  }

  /**
   * One window, every page. No filter parameter beyond `fields=all` and paging on a range read:
   * PayPal leaves `ending_balance` empty when a search is filtered, and the carry lines need it.
   */
  async function searchPages(start: number, end: number, extra: Record<string, string>): Promise<PayPalTransaction[]> {
    const out: PayPalTransaction[] = []
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        // Millisecond bounds: a window ending at 23:59:59.999 must not drop a 23:59:59.500 transaction.
        start_date: new Date(start).toISOString(),
        end_date: new Date(end).toISOString(),
        fields: 'all',
        page_size: '500',
        page: String(page),
        ...extra,
      })
      let res: PayPalSearchPage
      try {
        res = await call<PayPalSearchPage>('GET', `/v1/reporting/transactions?${q}`)
      } catch (e) {
        if (e instanceof PayPalError && (e.status === 401 || e.status === 403)) {
          throw new ProcessorPermissionError(PROVIDER, PERMISSION, `PayPal refused Transaction Search (${e.status}${/NOT_AUTHORIZED/.test(e.body) ? ' NOT_AUTHORIZED' : ''}): enable "Transaction search" on the app.`)
        }
        throw e
      }
      if (res.account_number) searchAccount ??= res.account_number
      out.push(...(res.transaction_details ?? []))
      if (!res.total_pages || page >= res.total_pages) return out
    }
  }

  /**
   * Every transaction in [start, end], in settlement order, in ≤31-day windows. Each window starts
   * where the previous one ended (inclusive, overlapping by that instant): PayPal's timestamps can
   * carry fractions of a second, and the query is to the second.
   */
  async function range(start: number, end: number): Promise<PayPalTransaction[]> {
    const out: PayPalTransaction[] = []
    for (let from = start; from < end; from += WINDOW_MS) out.push(...(await search(from, Math.min(from + WINDOW_MS, end))))
    return chronological(out)
  }

  /**
   * Deduplicated by transaction id, in settlement order: by the time the money reached the balance
   * (full precision; a delayed payment's settlement, see `isPayPalDelayedSettlement`), a payout
   * boundary (a completed or pending withdrawal) after every other movement of the same instant — a
   * payment, or a reversed withdrawal, in the same second as a withdrawal is in that withdrawal — then
   * id only to make the order stable.
   */
  function chronological(list: PayPalTransaction[]): PayPalTransaction[] {
    const seen = new Set<string>()
    const unique = list.filter((t) => (seen.has(idOf(t)) ? false : (seen.add(idOf(t)), true)))
    // A payment something else references (a refund, a dispute) keeps its initiation date: that
    // event may be what moved its transaction_updated_date.
    const referenced = new Set(unique.flatMap((t) => (t.transaction_info.paypal_reference_id && t.transaction_info.paypal_reference_id !== idOf(t) ? [t.transaction_info.paypal_reference_id] : [])))
    for (const t of unique) {
      settledAtCache.set(t, isPayPalDelayedSettlement(t) && !referenced.has(idOf(t)) ? paypalInstant(t.transaction_info.transaction_updated_date!) : instantOf(t))
    }
    return unique
      .map((t) => ({ t, at: settledAt(t), last: isBoundary(t) ? 1 : 0 }))
      .sort((a, b) => a.at - b.at || a.last - b.last || byId(a.t, b.t))
      .map((x) => x.t)
  }

  /**
   * `txns` read up to `readEnd`, plus what happened after it, up to `cap`, when a delayed payment that
   * could fall inside the payout(s) being read (`relevant`: started or settled inside them) may still
   * be referenced by a refund or dispute that `txns` does not reach — so the payment keeps its
   * initiation date however far the read went. A reference can only matter within
   * `PAYPAL_SETTLEMENT_DELAY_MAX_MS` of the payment's start (later, the delay rule no longer holds), so
   * the extra read stops there. No relevant delayed payment, or none that reaches past `readEnd`: no
   * extra call.
   */
  async function withReferences(txns: PayPalTransaction[], readEnd: number, cap: number, relevant: (t: PayPalTransaction) => boolean): Promise<PayPalTransaction[]> {
    const candidates = txns.filter((t) => isPayPalDelayedSettlement(t) && relevant(t))
    if (!candidates.length) return txns
    const until = Math.min(Math.max(...candidates.map(instantOf)) + PAYPAL_SETTLEMENT_DELAY_MAX_MS, cap, settled())
    if (until <= readEnd) return txns
    return chronological([...txns, ...(await range(readEnd, until))])
  }

  /** The recorded payout of each transaction that occurred in [from, to], in this mode's record (each mode groups independently). */
  async function assignmentsIn(assignments: PayoutAssignments | undefined, from: number, to: number, balance: boolean): Promise<Map<string, string>> {
    if (!assignments) return new Map()
    return assignments.inRange(balance ? 'balance' : 'withdrawal', new Date(from).toISOString(), new Date(to).toISOString())
  }

  /** The merchant's payer id when it can be read: cached, Log in with PayPal's userinfo, or what a search reported. */
  async function identity(): Promise<string | null> {
    if (account) return account
    try {
      const me = await call<{ payer_id?: string }>('GET', '/v1/identity/oauth2/userinfo?schema=paypalv1.1')
      if (me.payer_id) return (account = me.payer_id)
    } catch (e) {
      // An app without "Log in with PayPal" may not read its own identity; the client id still names it.
      if (!(e instanceof PayPalError && (e.status === 401 || e.status === 403 || e.status === 404))) throw e
    }
    return searchAccount ? (account = searchAccount) : null
  }

  /** Same payer id; the client id when nothing names the account. */
  async function accountId(): Promise<string> {
    return (await identity()) ?? (account = deps.clientId)
  }

  // ── withdrawal mode ──

  function previousBoundary(txns: PayPalTransaction[], index: number): number {
    const currency = currencyOf(txns[index]!)
    for (let i = index - 1; i >= 0; i--) if (isBoundary(txns[i]!) && currencyOf(txns[i]!) === currency) return i
    return -1
  }

  /**
   * The lines of the withdrawal at `index` in `txns`: same-currency, non-withdrawal balance movements
   * after the previous boundary that moved the balance — completed (`S`) or completed and later
   * reversed (`V`: the original did move the balance; its reversal is its own transaction). Pending
   * (`P`) and denied (`D`) ones never did; authorization events (T13xx) never do. `coveredFrom` is
   * where `txns` starts (null: as far back as PayPal keeps): null is returned when that is too late
   * to know — the previous boundary is not in `txns`, or a delayed payment settling after it could
   * have started before `coveredFrom`.
   */
  function linesOf(txns: PayPalTransaction[], index: number, coveredFrom: number | null): PayPalTransaction[] | null {
    const w = txns[index]!
    const currency = currencyOf(w)
    const from = previousBoundary(txns, index)
    if (coveredFrom !== null && (from === -1 || settledAt(txns[from]!) - PAYPAL_SETTLEMENT_DELAY_MAX_MS < coveredFrom)) return null
    // A reversed withdrawal (V) is no boundary but did take the money out: its debit is a `transfer`
    // line where it happened, and its reversal (T1101) the matching credit where that happened, so
    // each interval balances even when the two fall in different payouts.
    return txns
      .slice(from + 1, index)
      .filter((t) => (!isWithdrawal(t) || t.transaction_info.transaction_status === 'V') && currencyOf(t) === currency && movedBalance(t))
  }

  /**
   * The carry lines of the withdrawal at `index`, from PayPal's `ending_balance`: the balance after
   * the previous boundary (`carry_in`, positive) and after this withdrawal (`carry_out`, negative).
   * Null — no carry lines — when a needed `ending_balance` is missing, or when the balances do not
   * reconcile with the lines (`opening + Σ net − amount ≠ closing`: PayPal ordered a same-second
   * movement differently, or a line moved), so a carry line is never a plug.
   */
  function carryOf(txns: PayPalTransaction[], index: number, lines: PayPalTransaction[]): Carry | null {
    const w = txns[index]!
    const currency = currencyOf(w)
    const closing = balanceAfter(w, currency)
    if (closing === null) return null
    const from = previousBoundary(txns, index)
    let opening: number | null = null
    let source: PayPalTransaction | null = null
    if (from !== -1) {
      source = txns[from]!
      opening = balanceAfter(source, currency)
    } else if (lines.length) {
      // No earlier withdrawal in PayPal's history: the balance before the first movement.
      source = lines[0]!
      const after = balanceAfter(source, currency)
      opening = after === null ? null : after - netOf(source)
    }
    if (opening === null || !source) return null
    const amount = Math.abs(minor(w.transaction_info.transaction_amount.value, currency))
    if (opening + lines.reduce((s, t) => s + netOf(t), 0) - amount !== closing) return null
    return { carryIn: opening ? { amount: opening, source } : null, carryOut: closing ? { amount: -closing, source: w } : null }
  }

  const carryCount = (c: Carry | null) => (c?.carryIn ? 1 : 0) + (c?.carryOut ? 1 : 0)

  function toPayout(w: PayPalTransaction, accountId: string, lineCount: number | null): Payout {
    const info = w.transaction_info
    const currency = currencyOf(w)
    const createdAt = paypalTime(info.transaction_initiation_date)
    const status = withdrawalStatus(info.transaction_status)
    return {
      id: info.transaction_id,
      provider: PROVIDER,
      accountId,
      status,
      amount: { amount: Math.abs(minor(info.transaction_amount.value, currency)), currency },
      arrivalDate: createdAt.slice(0, 10),
      createdAt,
      method: info.transaction_event_code === 'T0400' ? 'withdrawal' : info.transaction_event_code,
      destinationLabel: null,
      lineCount: status === 'failed' || status === 'canceled' ? 0 : lineCount,
    }
  }

  function toLine(t: PayPalTransaction, orders: Map<string, string>): PayoutLine {
    const info = t.transaction_info
    const currency = currencyOf(t)
    const gross = minor(info.transaction_amount.value, currency)
    // PayPal reports the fee as a balance movement (negative); the line reports what PayPal kept.
    const fee = info.fee_amount ? -minor(info.fee_amount.value, currency) : 0
    // A withdrawal is a line only when PayPal reversed it: money that left for the bank and came back.
    const code = paypalLineCategory(info.transaction_event_code)
    const category: PayoutLineCategory = code === 'payout' ? 'transfer' : code
    const original = category === 'charge' ? info.transaction_id : info.paypal_reference_id ?? null
    const createdAt = paypalTime(info.transaction_initiation_date)
    return {
      id: info.transaction_id,
      type: info.transaction_event_code,
      category,
      sourceId: info.transaction_id,
      orderId: info.custom_field || (original ? orders.get(original) ?? null : null),
      orderNumber: null,
      paymentReference: original,
      gross: { amount: gross, currency },
      fee: { amount: fee, currency },
      net: { amount: gross - fee, currency },
      feeDetails: fee ? [{ type: 'paypal_fee', amount: fee, description: 'PayPal fee' }] : [],
      createdAt,
      availableOn: null,
      description: info.transaction_subject || info.transaction_note || info.invoice_id || null,
    }
  }

  function carryLine(kind: 'carry_in' | 'carry_out', amount: number, source: PayPalTransaction, currency: string): PayoutLine {
    const money = { amount, currency }
    const sourceId = idOf(source)
    return {
      id: `${kind}:${sourceId}`,
      type: kind,
      category: 'balance',
      sourceId,
      orderId: null,
      orderNumber: null,
      paymentReference: null,
      gross: money,
      fee: { amount: 0, currency },
      net: money,
      feeDetails: [],
      createdAt: paypalTime(source.transaction_info.transaction_initiation_date),
      availableOn: null,
      description:
        kind === 'carry_in'
          ? isWithdrawal(source)
            ? `PayPal balance left after withdrawal ${sourceId}`
            : 'PayPal balance before the first movement'
          : 'PayPal balance left after this withdrawal',
    }
  }

  /** Find a withdrawal by id, newest window first. */
  async function findWithdrawal(id: string): Promise<PayPalTransaction | null> {
    const end = settled()
    for (let w = 0; w < MAX_WINDOWS; w++) {
      const to = end - w * WINDOW_MS
      if (to <= end - HISTORY_MS) break
      const found = (await search(Math.max(to - WINDOW_MS, end - HISTORY_MS), to, { transaction_id: id })).find((t) => idOf(t) === id)
      if (found) return isWithdrawal(found) ? found : null
    }
    return null
  }

  /**
   * The withdrawal and every transaction back to the previous boundary in its currency and a
   * settlement delay before it (so a delayed payment that settled after that boundary is there).
   * `start` and `end` are the range read.
   */
  async function context(id: string): Promise<{ txns: PayPalTransaction[]; index: number; start: number; end: number } | null> {
    const w = await findWithdrawal(id)
    if (!w) return null
    const at = instantOf(w)
    const floor = now().getTime() - HISTORY_MS
    let start = Math.max(at - WINDOW_MS, floor)
    let txns = await range(start, at + 1000)
    for (let n = 1; n < MAX_WINDOWS && start > floor; n++) {
      const index = txns.findIndex((t) => idOf(t) === id)
      if (index !== -1 && linesOf(txns, index, start)) break
      const earlier = Math.max(start - WINDOW_MS, floor)
      txns = chronological([...(await range(earlier, start)), ...txns])
      start = earlier
    }
    // The range copy (it carries ending_balance; a search by id does not) wins over the lookup's.
    if (!txns.some((t) => idOf(t) === id)) txns = chronological([...txns, w])
    return { txns, index: txns.findIndex((t) => idOf(t) === id), start, end: Math.min(at + 1000, settled()) }
  }

  /**
   * The movement lines of the withdrawal at `index`, honouring the store's record: a withdrawal already
   * served as paid (its own id is recorded as its) has exactly its recorded transactions; any other has
   * `linesOf`'s, less the transactions recorded for another payout. Null when `linesOf` cannot know.
   */
  function membersOf(txns: PayPalTransaction[], index: number, recorded: Map<string, string>, coveredFrom: number | null): PayPalTransaction[] | null {
    const w = txns[index]!
    const slice = linesOf(txns, index, coveredFrom)
    if (!slice) return null
    if (recorded.get(idOf(w)) === idOf(w)) return txns.filter((t) => t !== w && recorded.get(idOf(t)) === idOf(w))
    return slice.filter((t) => !recorded.has(idOf(t)))
  }

  function orderMap(txns: PayPalTransaction[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const t of txns) if (t.transaction_info.custom_field) map.set(idOf(t), t.transaction_info.custom_field)
    return map
  }

  /**
   * A withdrawal and its lines in display order: carry_in, movements by settlement time then id,
   * carry_out. A paid withdrawal served for the first time is recorded (itself and its movements), so
   * its lines never change afterwards.
   */
  async function withdrawal(id: string, assignments: PayoutAssignments | undefined): Promise<{ w: PayPalTransaction; lines: PayoutLine[] } | null> {
    const ctx = await context(id)
    if (!ctx) return null
    let txns = ctx.txns
    let index = ctx.index
    const w = txns[index]!
    const status = withdrawalStatus(w.transaction_info.transaction_status)
    if (status !== 'paid' && status !== 'in_transit') return { w, lines: [] }
    const recorded = await assignmentsIn(assignments, ctx.start, ctx.end, false)
    const fixed = recorded.get(id) === id
    if (!fixed) {
      const from = previousBoundary(txns, index)
      const after = from === -1 ? -Infinity : settledAt(txns[from]!)
      const at = settledAt(w)
      const inside = (x: number) => x > after && x <= at
      txns = await withReferences(txns, ctx.end, settled(), (t) => inside(instantOf(t)) || inside(updatedOf(t)))
      index = txns.findIndex((t) => idOf(t) === id)
    }
    const moves = membersOf(txns, index, recorded, null)!
    if (status === 'paid' && !fixed && assignments) await assignments.assign('withdrawal', id, [w, ...moves].map(assignmentRow))
    const carry = carryOf(txns, index, moves)
    const orders = orderMap(txns)
    const currency = currencyOf(w)
    const lines = [
      ...(carry?.carryIn ? [carryLine('carry_in', carry.carryIn.amount, carry.carryIn.source, currency)] : []),
      ...[...moves].sort((a, b) => settledAt(a) - settledAt(b) || byId(a, b)).map((t) => toLine(t, orders)),
      ...(carry?.carryOut ? [carryLine('carry_out', carry.carryOut.amount, carry.carryOut.source, currency)] : []),
    ]
    return { w, lines }
  }

  // ── balance mode ──

  /**
   * The balance days of `txns` with their lines, for days in [from, to]. A recorded transaction is in
   * its recorded day; an unrecorded one in the day it settled (if that is in [from, to]) unless that
   * day is already recorded (served as paid), whose lines never change.
   */
  function balanceDays(txns: PayPalTransaction[], from: number, to: number, recorded: Map<string, string>): Map<string, PayPalTransaction[]> {
    const fixedDays = new Set(recorded.values())
    const firstDay = utcDay(from)
    const days = new Map<string, PayPalTransaction[]>()
    for (const t of txns) {
      if (!isBalanceDayLine(t)) continue
      let id = recorded.get(idOf(t))
      if (id) {
        const day = Date.parse(`${DAY_ID.exec(id)![1]}T00:00:00Z`)
        if (day < firstDay || day > to) continue
      } else {
        const at = settledAt(t)
        if (at < from || at > to) continue
        id = `day-${dateOf(utcDay(at))}-${currencyOf(t).toUpperCase()}`
        if (fixedDays.has(id)) continue
      }
      const list = days.get(id)
      if (list) list.push(t)
      else days.set(id, [t])
    }
    for (const list of days.values()) list.sort((a, b) => settledAt(a) - settledAt(b) || byId(a, b))
    return days
  }

  /**
   * A balance day as a payout. `covered` is the last instant (ms, inclusive) the read behind it
   * reached, already at least the reporting lag behind its clock: the day is `paid` only when that
   * read covered the whole day, so a day is never final on a read that stopped inside it.
   */
  function toDayPayout(id: string, lines: PayPalTransaction[], accountId: string, covered: number): Payout {
    const [, date, currencyCode] = DAY_ID.exec(id)!
    const day = Date.parse(`${date}T00:00:00Z`)
    return {
      id,
      provider: PROVIDER,
      accountId,
      status: day + DAY_MS - 1 <= covered ? 'paid' : 'pending',
      amount: { amount: lines.reduce((s, t) => s + netOf(t), 0), currency: currencyCode!.toLowerCase() },
      arrivalDate: date!,
      createdAt: `${date}T23:59:59Z`,
      method: 'balance',
      destinationLabel: 'PayPal balance',
      lineCount: lines.length,
    }
  }

  /**
   * One balance day: its movements, everything read (for order links) and the payout, or null when the
   * id names no day with any. A paid day served for the first time is recorded, so its lines never
   * change afterwards.
   */
  async function balanceDay(id: string, assignments: PayoutAssignments | undefined): Promise<{ lines: PayPalTransaction[]; txns: PayPalTransaction[]; payout: Payout } | null> {
    const m = DAY_ID.exec(id)
    if (!m) return null
    const day = Date.parse(`${m[1]}T00:00:00Z`)
    if (Number.isNaN(day) || dateOf(day) !== m[1]) return null
    const covered = Math.min(day + DAY_MS - 1, settled())
    if (day + DAY_MS <= historyFloor() || day > covered) return null
    const start = Math.max(day - PAYPAL_SETTLEMENT_DELAY_MAX_MS, historyFloor())
    let txns = await range(start, covered)
    const recorded = await assignmentsIn(assignments, start, covered, true)
    const fixed = [...recorded.values()].includes(id)
    if (!fixed) {
      const inDay = (x: number) => x >= day && x < day + DAY_MS
      txns = await withReferences(txns, covered, settled(), (t) => inDay(instantOf(t)) || inDay(updatedOf(t)))
    }
    const lines = balanceDays(txns, day, covered, recorded).get(id)
    if (!lines?.length) return null
    const payout = toDayPayout(id, lines, await accountId(), covered)
    if (payout.status === 'paid' && !fixed && assignments) await assignments.assign('balance', id, lines.map(assignmentRow))
    return { lines, txns, payout }
  }

  return {
    reportingLagMs: deps.reportingLagMs ?? PAYPAL_REPORTING_LAG_MS,

    async account() {
      try {
        return await identity()
      } catch {
        return null
      }
    },

    async list({ createdSince, after, limit, until, mode, asOf, assignments }) {
      const balance = payoutMode(mode) === 'balance'
      // Everything this list reads and reports is as of `asOf` (fixed for a whole paged run).
      const horizon = Math.min(asOf ?? now().getTime(), now().getTime()) - (deps.reportingLagMs ?? PAYPAL_REPORTING_LAG_MS)
      const end = until ? Math.min(horizon, Date.parse(until) + 999) : horizon
      const lower = Date.parse(after && after.createdAt > createdSince ? after.createdAt : createdSince)
      // A balance day is created at its last second, so the first day that can qualify starts at midnight.
      const first = Math.max(balance ? utcDay(lower) : lower, historyFloor())
      if (first >= end) return { payouts: [], hasMore: false }
      // Read a settlement delay earlier: a delayed payment started before `first` may settle after it.
      const start = Math.max(first - PAYPAL_SETTLEMENT_DELAY_MAX_MS, historyFloor())
      let txns = await range(start, end)
      const recorded = await assignmentsIn(assignments, start, end, balance)
      const inside = (x: number) => x >= first && x <= end
      txns = await withReferences(txns, end, horizon, (t) => inside(instantOf(t)) || inside(updatedOf(t)))
      const id = await accountId()
      const candidates = balance
        ? [...balanceDays(txns, first, end, recorded)].map(([dayId, lines]) => toDayPayout(dayId, lines, id, end))
        : txns
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => isWithdrawal(t) && instantOf(t) <= end)
            .map(({ t, i }) => {
              const lines = membersOf(txns, i, recorded, start)
              return toPayout(t, id, lines ? lines.length + carryCount(carryOf(txns, i, lines)) : null)
            })
      const ordered = candidates.filter((p) => p.createdAt >= createdSince && isAfter(p, after) && isWithin(p, until)).sort(comparePayouts)
      return { payouts: ordered.slice(0, limit), hasMore: ordered.length > limit }
    },

    async get(id, options) {
      payoutMode(options?.mode)
      if (DAY_ID.test(id)) return (await balanceDay(id, options?.assignments))?.payout ?? null
      const found = await withdrawal(id, options?.assignments)
      return found ? toPayout(found.w, await accountId(), found.lines.length) : null
    },

    async lines(payoutId, { cursor, limit, mode, assignments }) {
      payoutMode(mode)
      let offset = 0
      if (cursor) {
        const parts = decodeKeysetCursor(cursor, 1)
        if (!parts || typeof parts[0] !== 'number' || !Number.isInteger(parts[0]) || parts[0] < 0) throw invalid('Invalid query', { cursor: 'was not issued by this store' })
        offset = parts[0]
      }
      let all: PayoutLine[]
      if (DAY_ID.test(payoutId)) {
        const day = await balanceDay(payoutId, assignments)
        if (!day) throw notFound(`Payout ${payoutId}`)
        const orders = orderMap(day.txns)
        all = day.lines.map((t) => toLine(t, orders))
      } else {
        const found = await withdrawal(payoutId, assignments)
        if (!found) throw notFound(`Payout ${payoutId}`)
        all = found.lines
      }
      return { lines: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? encodeKeysetCursor([offset + limit]) : null }
    },
  }
}
