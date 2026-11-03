import type Stripe from 'stripe'
import type { CheckoutItem } from '../store/checkout'
import type { Address, Order, PaymentSettlement } from '../types'
import { decodeKeysetCursor, encodeKeysetCursor } from '../store/cursor'
import { invalid, notFound } from '../store/errors'
import {
  comparePayouts, isAfter, isoSeconds, isWithin, PaymentWebhookError, ProcessorPermissionError,
  type PaymentAdapter, type PaymentContext, type PaymentEvent, type PaymentPayouts, type PaymentStart, type Payout,
  type PayoutLine, type PayoutLineCategory,
} from './index'

export interface StripePaymentOptions {
  /** A configured Stripe client (use `Stripe.createFetchHttpClient()` on Workers). */
  stripe: Stripe
  /** Signing secret of the webhook endpoint that points at /api/payments/webhook. */
  webhookSecret: string | undefined
  /** WebCrypto provider for signature checks on Workers: `Stripe.createSubtleCryptoProvider()`. */
  cryptoProvider?: Stripe.CryptoProvider
  /** Extra Checkout Session fields, e.g. `{ payment_method_types: ['card'] }`. */
  session?: Partial<Stripe.Checkout.SessionCreateParams>
}

const PROVIDER = 'stripe'
/** Marks a PaymentIntent made by `stripeExpress`; hosted Checkout's intents are settled by their session. */
const EXPRESS = 'express'

/**
 * Stripe hosted Checkout in payment-only mode. The store has already taken
 * the address and shipping choice, so the session carries the order's lines
 * and shipping as fixed amounts and identifies the order by
 * `client_reference_id` / `metadata.order_id`.
 */
export function stripePayments(options: StripePaymentOptions): PaymentAdapter {
  const { stripe } = options

  return {
    id: PROVIDER,
    label: 'Card',

    async start(order, ctx): Promise<PaymentStart> {
      const currency = order.currency.toLowerCase()
      const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = order.lines.map((l) => ({
        quantity: l.quantity,
        price_data: {
          currency,
          unit_amount: l.unitAmount.amount,
          product_data: { name: l.name, metadata: { sku: l.sku } },
        },
      }))
      const shippingOption: Stripe.Checkout.SessionCreateParams.ShippingOption[] = order.shippingMethod
        ? [
            {
              shipping_rate_data: {
                type: 'fixed_amount',
                display_name: order.shippingMethod.name.slice(0, 100),
                fixed_amount: { amount: order.shipping.amount, currency },
                metadata: { shipping_option_id: order.shippingMethod.code },
              },
            },
          ]
        : []
      // A store discount is already in the order's total. Stripe Checkout cannot take a negative line, so the
      // amount rides on a single-use coupon named after the code; Stripe forbids promotion codes alongside it.
      const discounts: Stripe.Checkout.SessionCreateParams.Discount[] = []
      if (order.discount.amount > 0) {
        const coupon = await stripe.coupons.create({
          amount_off: order.discount.amount,
          currency,
          duration: 'once',
          max_redemptions: 1,
          name: (order.discountCode ?? 'Discount').slice(0, 40),
          metadata: { order_id: order.id },
        })
        discounts.push({ coupon: coupon.id })
      }
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: 'payment',
        line_items,
        client_reference_id: order.id,
        customer_email: order.customer.email,
        metadata: metadataFor(order),
        payment_intent_data: {
          metadata: metadataFor(order),
          description: describeOrder(order, ctx),
          ...shippingFor(order),
        },
        ...(shippingOption.length ? { shipping_options: shippingOption } : {}),
        ...(discounts.length ? { discounts } : { allow_promotion_codes: ctx.store.config.checkout.allowPromotionCodes }),
        billing_address_collection: 'auto',
        success_url: `${ctx.siteUrl}/checkout/success/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${ctx.siteUrl}/cart/?checkout_error=cancelled&order=${encodeURIComponent(order.id)}`,
        ...options.session,
      }
      const session = await stripe.checkout.sessions.create(params)
      if (!session.url) throw new Error(`Stripe session ${session.id} has no url`)
      await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: session.id })
      return { kind: 'redirect', url: session.url }
    },

    async handleWebhook(request): Promise<PaymentEvent[]> {
      if (!options.webhookSecret) throw new PaymentWebhookError(500, 'STRIPE_WEBHOOK_SECRET is not configured')
      const signature = request.headers.get('stripe-signature')
      if (!signature) throw new PaymentWebhookError(400, 'missing stripe-signature header')
      let event: Stripe.Event
      try {
        event = await stripe.webhooks.constructEventAsync(await request.text(), signature, options.webhookSecret, undefined, options.cryptoProvider)
      } catch (e) {
        throw new PaymentWebhookError(400, `invalid signature: ${e instanceof Error ? e.message : String(e)}`)
      }
      return withSettlement(stripe, eventsFromStripe(event))
    },

    async verifyReturn(params, order): Promise<PaymentEvent[]> {
      // Express (stripeExpress): Stripe appends the intent to the return URL.
      const intentId = params.get('payment_intent')
      if (intentId && !params.get('session_id')) {
        const pi = await stripe.paymentIntents.retrieve(intentId, { expand: [...SETTLEMENT_EXPAND] })
        if (pi.metadata?.order_id !== order.id) return []
        return pi.status === 'succeeded' ? [{ ...paidFromIntent(pi), ...settlementFields(pi) } as PaymentEvent] : []
      }
      const sessionId = params.get('session_id')
      if (!sessionId) return []
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      if (orderIdOf(session) !== order.id) return []
      return session.payment_status === 'paid' ? withSettlement(stripe, [paidEvent(session)]) : []
    },

    async settlement(order): Promise<PaymentSettlement | null> {
      const intentId = order.payment.reference
      if (!intentId?.startsWith('pi_')) return null
      return settlementOf(await stripe.paymentIntents.retrieve(intentId, { expand: [...SETTLEMENT_EXPAND] }))
    },

    payouts: stripePayouts(stripe),
  }
}

// ── Payouts ─────────────────────────────────────────────────────────────────────────────────
//
// A Stripe payout settles a set of balance transactions. `lines()` lists them
// (`balance_transactions?payout=`), minus the payout's own `payout` row, keeping Stripe's signs:
// gross = `amount`, fee = `fee`, net = `net` (refunds and disputes are negative; a dispute's fee is
// positive, a won dispute's reversal gives it back as a negative fee). Their nets sum to the
// payout's `amount`. A restricted key needs "Payouts: Read", "Balance: Read" and "Balance transaction
// sources: Read" (the lines expand each row's source, and a refund's or dispute's charge, inline).

/** Most payouts one list request walks (Stripe pages are 100): about five years of daily payouts. */
const MAX_PAYOUT_PAGES = 20
/** Most balance-transaction pages `get()` reads to count a payout's lines (1,000 lines); beyond it `line_count` is null. */
const MAX_COUNT_PAGES = 10

/** Stripe `reporting_category` (preferred) or `type` → line category. */
const STRIPE_CATEGORIES: Record<string, PayoutLineCategory> = {
  charge: 'charge',
  payment: 'charge',
  charge_failure: 'charge',
  refund: 'refund',
  payment_refund: 'refund',
  refund_failure: 'refund',
  payment_failure_refund: 'refund',
  dispute: 'dispute',
  dispute_reversal: 'dispute_reversal',
  fee: 'fee',
  stripe_fee: 'fee',
  tax: 'fee',
  network_cost: 'fee',
  risk_reserved_funds: 'reserve',
  risk_reserve_released: 'reserve',
  reserve_transaction: 'reserve',
  reserved_funds: 'reserve',
  adjustment: 'adjustment',
  other_adjustment: 'adjustment',
  transfer: 'transfer',
  transfer_reversal: 'transfer',
  topup: 'transfer',
  topup_reversal: 'transfer',
}

/** Exported for tests. */
export function stripeLineCategory(bt: { reporting_category?: string | null; type: string }): PayoutLineCategory {
  return (bt.reporting_category && STRIPE_CATEGORIES[bt.reporting_category]) || STRIPE_CATEGORIES[bt.type] || 'other'
}

type StripeErrorLike = { type?: string; statusCode?: number; code?: string; message?: string }

/** What Stripe names when a key may read balance transactions but not the objects behind them. */
const SOURCES_PERMISSION = 'Balance transaction sources: Read'

function permissionError(e: unknown, permission: string): ProcessorPermissionError | null {
  const err = e as StripeErrorLike
  if (err?.type === 'StripePermissionError' || err?.type === 'StripeAuthenticationError' || err?.statusCode === 401 || err?.statusCode === 403) {
    // Stripe's message names the missing permission (`rak_balance_transaction_source_read`); trust it over the call's.
    const named = /balance_transaction_source/i.test(`${err.message ?? ''} ${err.code ?? ''}`) ? SOURCES_PERMISSION : permission
    return new ProcessorPermissionError(PROVIDER, named, `Stripe refused the store's key: ${err.message ?? 'permission denied'}. Grant "${named}" on the restricted key.`)
  }
  return null
}

async function guarded<T>(permission: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    throw permissionError(e, permission) ?? e
  }
}

const isMissing = (e: unknown) => (e as StripeErrorLike)?.code === 'resource_missing' || (e as StripeErrorLike)?.statusCode === 404

function destinationLabel(destination: Stripe.Payout['destination']): string | null {
  if (!destination || typeof destination === 'string') return null
  const d = destination as { object?: string; bank_name?: string | null; brand?: string | null; last4?: string | null }
  const name = d.object === 'card' ? d.brand : d.bank_name
  if (!d.last4) return name ?? null
  return `${name ? `${titleCase(name)} ` : ''}••${d.last4}`
}

/** "JPMORGAN CHASE" reads as "Jpmorgan Chase"; a mixed-case name is kept. */
function titleCase(name: string): string {
  return name === name.toUpperCase() ? name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : name
}

const dateOf = (unix: number | null | undefined) => (typeof unix === 'number' ? isoSeconds(unix).slice(0, 10) : null)

/**
 * The payout capability for a Stripe client. `stripePayments` includes it; exported for stores that
 * take payments some other way but want their Stripe payouts in the Store API.
 */
export function stripePayouts(stripe: Stripe): PaymentPayouts {
  let account: Promise<string> | null = null
  /** Whether the key may expand `destination` (needs more than "Payouts: Read" on some keys). */
  let expandDestination = true

  function accountId(): Promise<string> {
    account ??= guarded('Account: Read', async () => (await stripe.accounts.retrieve()).id).catch((e) => {
      account = null
      throw e
    })
    return account
  }

  async function listPage(params: Stripe.PayoutListParams): Promise<Stripe.ApiList<Stripe.Payout>> {
    if (expandDestination) {
      try {
        return await stripe.payouts.list({ ...params, expand: ['data.destination'] })
      } catch (e) {
        if (!permissionError(e, '')) throw e
        // The key reads payouts but not the bank account: list without the label instead of failing.
        expandDestination = false
      }
    }
    return guarded('Payouts: Read', () => stripe.payouts.list(params))
  }

  async function retrieve(id: string): Promise<Stripe.Payout | null> {
    try {
      if (expandDestination) {
        try {
          return await stripe.payouts.retrieve(id, { expand: ['destination'] })
        } catch (e) {
          if (!permissionError(e, '')) throw e
          expandDestination = false
        }
      }
      return await guarded('Payouts: Read', () => stripe.payouts.retrieve(id))
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
  }

  function toPayout(p: Stripe.Payout, accountId: string, lineCount: number | null): Payout {
    return {
      id: p.id,
      provider: PROVIDER,
      accountId,
      status: p.status as Payout['status'],
      amount: { amount: p.amount, currency: p.currency.toLowerCase() },
      arrivalDate: dateOf(p.arrival_date),
      createdAt: isoSeconds(p.created),
      method: p.method ?? null,
      destinationLabel: destinationLabel(p.destination),
      lineCount,
    }
  }

  /** Balance transactions of an automatic payout; a manual (Dashboard) payout has none to list. */
  async function transactions(payout: string, params: { starting_after?: string; limit: number; expand?: string[] }): Promise<Stripe.ApiList<Stripe.BalanceTransaction>> {
    try {
      return await guarded('Balance: Read', () => stripe.balanceTransactions.list({ payout, ...params }))
    } catch (e) {
      if ((e as StripeErrorLike)?.type !== 'StripeInvalidRequestError') throw e
      const p = await retrieve(payout)
      if (!p) throw notFound(`Payout ${payout}`)
      if (!p.automatic) return { object: 'list', data: [], has_more: false, url: '' }
      throw e
    }
  }

  /** The line count, or null when counting would take more than `MAX_COUNT_PAGES` Stripe calls. */
  async function countLines(p: Stripe.Payout): Promise<number | null> {
    if (!p.automatic) return 0
    let count = 0
    let startingAfter: string | undefined
    for (let pages = 0; ; pages++) {
      if (pages === MAX_COUNT_PAGES) return null
      const page = await transactions(p.id, { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
      count += page.data.filter((bt) => bt.type !== 'payout').length
      if (!page.has_more || !page.data.length) return count
      startingAfter = page.data[page.data.length - 1]!.id
    }
  }

  /**
   * The lines' balance transactions with each source, and a refund's or dispute's charge, expanded
   * inline: one Stripe request per page, whatever the page holds (a Worker has a subrequest budget).
   * A key that may not expand the charge falls back once to the sources alone; those lines lose
   * their order link (unless the charge is on the same page) instead of failing.
   */
  async function lineTransactions(payout: string, params: { starting_after?: string; limit: number }): Promise<Stripe.ApiList<Stripe.BalanceTransaction>> {
    try {
      return await stripe.balanceTransactions.list({ payout, ...params, expand: ['data.source', 'data.source.charge'] })
    } catch (e) {
      // A refused expansion (or a manual payout, which `transactions` recognises) takes the one fallback;
      // a key that cannot read balance transactions at all fails there with the permission it lacks.
      if (!permissionError(e, '') && (e as StripeErrorLike)?.type !== 'StripeInvalidRequestError') throw e
      return transactions(payout, { ...params, expand: ['data.source'] })
    }
  }

  /** The charge behind a balance transaction's source: the charge itself, or the (expanded) one a refund/dispute is for. */
  function chargeFor(source: Stripe.BalanceTransaction['source'], onPage: Map<string, Stripe.Charge>): Stripe.Charge | null {
    if (!source || typeof source === 'string') return null
    const s = source as { object?: string; charge?: string | Stripe.Charge | null }
    if (s.object === 'charge') return source as Stripe.Charge
    const charge = s.charge
    if (!charge) return null
    return typeof charge === 'object' ? charge : onPage.get(charge) ?? null
  }

  function toLine(bt: Stripe.BalanceTransaction, onPage: Map<string, Stripe.Charge>): PayoutLine {
    const currency = bt.currency.toLowerCase()
    const charge = chargeFor(bt.source, onPage)
    const sourceId = typeof bt.source === 'string' ? bt.source : bt.source?.id ?? null
    const intent = charge?.payment_intent
    return {
      id: bt.id,
      type: bt.type,
      category: stripeLineCategory(bt),
      sourceId,
      orderId: charge?.metadata?.order_id || null,
      orderNumber: charge?.metadata?.order_number || null,
      paymentReference: typeof intent === 'string' ? intent : intent?.id ?? null,
      gross: { amount: bt.amount, currency },
      fee: { amount: bt.fee, currency },
      net: { amount: bt.net, currency },
      feeDetails: (bt.fee_details ?? []).map((f) => ({ type: f.type, amount: f.amount, description: f.description ?? null })),
      createdAt: isoSeconds(bt.created),
      availableOn: dateOf(bt.available_on),
      description: bt.description ?? null,
    }
  }

  return {
    async list({ createdSince, after, limit, until }) {
      const since = Math.floor(Date.parse(after && after.createdAt > createdSince ? after.createdAt : createdSince) / 1000)
      const created = until ? { gte: since, lte: Math.floor(Date.parse(until) / 1000) } : { gte: since }
      // Stripe lists newest first; walk back to `since`, then serve oldest first.
      const all: Stripe.Payout[] = []
      let startingAfter: string | undefined
      for (let page = 0; ; page++) {
        if (page === MAX_PAYOUT_PAGES) throw invalid('Too many payouts in one range; use a later created_since', { created_since: `more than ${MAX_PAYOUT_PAGES * 100} payouts since it` })
        const res = await listPage({ created, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
        all.push(...res.data)
        if (!res.has_more || !res.data.length) break
        startingAfter = res.data[res.data.length - 1]!.id
      }
      const id = all.length ? await accountId() : ''
      const ordered = all
        .map((p) => toPayout(p, id, null))
        .filter((p) => isAfter(p, after) && isWithin(p, until))
        .sort(comparePayouts)
      return { payouts: ordered.slice(0, limit), hasMore: ordered.length > limit }
    },

    async get(id) {
      const p = await retrieve(id)
      if (!p) return null
      return toPayout(p, await accountId(), await countLines(p))
    },

    async lines(payoutId, { cursor, limit }) {
      let startingAfter: string | undefined
      if (cursor) {
        const parts = decodeKeysetCursor(cursor, 1)
        if (!parts || typeof parts[0] !== 'string') throw invalid('Invalid query', { cursor: 'was not issued by this store' })
        startingAfter = parts[0]
      }
      const page = await lineTransactions(payoutId, { limit, ...(startingAfter ? { starting_after: startingAfter } : {}) })
      if (!page.data.length && !startingAfter && !(await retrieve(payoutId))) throw notFound(`Payout ${payoutId}`)
      // Charges on this page answer their own refunds and disputes when the charge could not be expanded.
      const onPage = new Map<string, Stripe.Charge>()
      for (const row of page.data) {
        const source = row.source as { object?: string; id?: string } | string | null
        if (source && typeof source === 'object' && source.object === 'charge' && source.id) onPage.set(source.id, source as Stripe.Charge)
      }
      const lines = page.data.filter((bt) => bt.type !== 'payout').map((bt) => toLine(bt, onPage))
      const last = page.data[page.data.length - 1]
      return { lines, nextCursor: page.has_more && last ? encodeKeysetCursor([last.id]) : null }
    },
  }
}

/** The PaymentIntent with its charge and the charge's balance transaction (fee, net) inline. */
const SETTLEMENT_EXPAND = ['latest_charge.balance_transaction'] as const

/**
 * What Stripe captured and kept for a PaymentIntent retrieved with SETTLEMENT_EXPAND. The fee and net
 * come from the balance transaction, in the account's settlement currency; while Stripe has not
 * created it yet (it can lag the charge) they stay null and the Store API fills them in later.
 */
export function settlementOf(pi: Stripe.PaymentIntent): PaymentSettlement | null {
  if (pi.status !== 'succeeded') return null
  const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null
  const bt = charge && typeof charge.balance_transaction === 'object' && charge.balance_transaction ? charge.balance_transaction : null
  const currency = pi.currency.toLowerCase()
  return {
    amountReceived: { amount: pi.amount_received || charge?.amount_captured || pi.amount, currency },
    transactionId: typeof pi.latest_charge === 'string' ? pi.latest_charge : charge?.id ?? null,
    fee: bt ? { amount: bt.fee, currency: bt.currency.toLowerCase() } : null,
    net: bt ? { amount: bt.net, currency: bt.currency.toLowerCase() } : null,
  }
}

function settlementFields(pi: Stripe.PaymentIntent): { settlement?: PaymentSettlement } {
  const settlement = settlementOf(pi)
  return settlement ? { settlement } : {}
}

/**
 * Attach the settlement to each paid event by reading its PaymentIntent back. A Stripe error here
 * never loses the payment: the event goes through without it, and GET /orders/{id} fills it in later.
 */
async function withSettlement(stripe: Stripe, events: PaymentEvent[]): Promise<PaymentEvent[]> {
  return Promise.all(
    events.map(async (event) => {
      if (event.type !== 'paid' || !event.reference?.startsWith('pi_')) return event
      try {
        const pi = await stripe.paymentIntents.retrieve(event.reference, { expand: [...SETTLEMENT_EXPAND] })
        return { ...event, ...settlementFields(pi) }
      } catch (e) {
        console.error('stripe: could not read the settlement for', event.reference, e instanceof Error ? e.message : String(e))
        return event
      }
    })
  )
}

function metadataFor(order: Order): Record<string, string> {
  return {
    order_id: order.id,
    order_number: order.number,
    ...Object.fromEntries(Object.entries(order.metadata).slice(0, 10)),
  }
}

/** The order's ship-to as Stripe's `shipping`, when it has one. */
function shippingFor(order: Order): { shipping?: Stripe.Checkout.SessionCreateParams.PaymentIntentData.Shipping } {
  const a = order.shippingAddress
  if (!a.line1 || !a.country) return {}
  return {
    shipping: {
      name: (a.name ?? order.customer.name ?? order.customer.email).slice(0, 100),
      ...(order.customer.phone ? { phone: order.customer.phone } : {}),
      address: {
        line1: a.line1,
        ...(a.line2 ? { line2: a.line2 } : {}),
        ...(a.city ? { city: a.city } : {}),
        ...(a.state ? { state: a.state } : {}),
        ...(a.postalCode ? { postal_code: a.postalCode } : {}),
        country: a.country,
      },
    },
  }
}

function describeOrder(order: Order, ctx: PaymentContext): string {
  return `${ctx.store.config.name} order ${ctx.store.config.orders.numberPrefix}${order.number}`
}

export interface StripeExpressOptions {
  /** A configured Stripe client (use `Stripe.createFetchHttpClient()` on Workers). */
  stripe: Stripe
}

export interface StripeExpress {
  /**
   * Approve-first express checkout (preferred). Confirms the wallet's ConfirmationToken on the
   * server as a HOLD (`capture_method: manual`) for exactly `amount`: nothing is charged and no
   * store order exists yet. A decline, a dismissed sheet or any wallet error therefore leaves
   * nothing behind. Create the store order only from an `authorized` result (read the buyer back
   * with `buyer`), then `attach` and `capture`. A hold that is never captured expires on its own.
   */
  authorize(input: StripeExpressAuthorizeInput): Promise<StripeExpressAuthorization>
  /** What the buyer approved, read back from Stripe — never from the browser. */
  buyer(intentId: string): Promise<StripeExpressBuyer>
  /** Tie the hold to the store order made for it, so the webhook and the dashboard name the order. */
  attach(intentId: string, order: Order, ctx: PaymentContext): Promise<void>
  /** Take the held money. Idempotent; returns the `paid` event (with settlement) for `applyPaymentEvents`. */
  capture(intentId: string): Promise<PaymentEvent[]>
  /** Drop a hold that will not become an order (price changed, order could not be made). Never throws. */
  release(intentId: string): Promise<void>
  /**
   * @deprecated Order-first express: the store order exists before the wallet confirms, so every
   * failed or abandoned tap leaves an unpaid order. Use `authorize` → `buyer` → `attach` → `capture`.
   *
   * A PaymentIntent for exactly the store order's total, for the browser to confirm with the
   * Express Checkout Element (Apple Pay, Google Pay, Link). Create the store order from the
   * wallet's address first; the intent is tagged `checkout: express` so its
   * `payment_intent.succeeded` marks the order paid.
   */
  intent(order: Order, ctx: PaymentContext): Promise<{ clientSecret: string; paymentIntentId: string }>
}

export interface StripeExpressAuthorizeInput {
  /** `stripe.createConfirmationToken({ elements })` from the Express Checkout Element's `confirm` event. */
  confirmationTokenId: string
  /** The store's price for these items to the wallet's address, minor units. Never the browser's number. */
  amount: number
  currency: string
  /** Recorded on the hold so the order is rebuilt from Stripe, not from a second browser request. */
  items: CheckoutItem[]
  /** Statement description until the order exists, e.g. `${store.config.name} order`. */
  description: string
  /** Attribution and the like; at most 10 entries are kept. */
  metadata?: Record<string, string>
}

export type StripeExpressAuthorization =
  /** Held: read the buyer, make the order, attach, capture. */
  | { status: 'authorized'; intentId: string }
  /** 3-D Secure or similar: the browser runs `stripe.handleNextAction({ clientSecret })`, then the store continues with `intentId`. */
  | { status: 'requires_action'; intentId: string; clientSecret: string }
  /** The card or wallet said no. Nothing was held and no order should be made. */
  | { status: 'declined'; intentId: string | null; message: string }

export interface StripeExpressBuyer {
  intentId: string
  /** Stripe's status; `requires_capture` means the hold is in place and can become an order. */
  status: string
  email: string
  name: string | null
  phone: string | null
  shippingAddress: Address
  /** What is held, minor units. */
  amount: { amount: number; currency: string }
  /** The items the hold was placed for. */
  items: CheckoutItem[]
  /** The store order already made for this hold (a repeated request), or null. */
  orderId: string | null
}

/**
 * Stripe express checkout: the buyer pays from a wallet button before seeing any form, and the
 * wallet supplies name, email and address. Approve-first: `authorize` holds the money from the
 * wallet's ConfirmationToken, the store makes the order only once the hold succeeds, then
 * captures — the same shape as PayPal express (`paypalExpress`). Hosted Checkout
 * (`stripePayments`) stays the card path; both settle through the same webhook.
 */
export function stripeExpress(options: StripeExpressOptions): StripeExpress {
  const { stripe } = options

  async function intentWithMethod(intentId: string): Promise<Stripe.PaymentIntent> {
    return stripe.paymentIntents.retrieve(intentId, { expand: ['payment_method'] })
  }

  return {
    async authorize(input) {
      const items = encodeItems(input.items)
      try {
        const pi = await stripe.paymentIntents.create(
          {
            amount: input.amount,
            currency: input.currency.toLowerCase(),
            confirm: true,
            confirmation_token: input.confirmationTokenId,
            // Hold, then capture once the order exists: a failure never charges and never leaves an order.
            capture_method: 'manual',
            // Wallets and Link only; a redirect method would need a return page this flow does not have.
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            description: input.description.slice(0, 1000),
            metadata: {
              ...limitMetadata(input.metadata ?? {}),
              checkout: EXPRESS,
              items,
              confirmation_token: input.confirmationTokenId,
            },
          },
          { idempotencyKey: `express-authorize-${input.confirmationTokenId}` }
        )
        if (pi.status === 'requires_capture') return { status: 'authorized', intentId: pi.id }
        if (pi.status === 'requires_action' && pi.client_secret) return { status: 'requires_action', intentId: pi.id, clientSecret: pi.client_secret }
        return { status: 'declined', intentId: pi.id, message: pi.last_payment_error?.message ?? 'The payment was not approved.' }
      } catch (e) {
        const err = e as { type?: string; message?: string; payment_intent?: { id?: string } }
        if (err?.type === 'StripeCardError') return { status: 'declined', intentId: err.payment_intent?.id ?? null, message: err.message ?? 'Your card was declined.' }
        throw e
      }
    },

    async buyer(intentId) {
      const pi = await intentWithMethod(intentId)
      const pm = typeof pi.payment_method === 'object' && pi.payment_method ? pi.payment_method : null
      let shipping = pi.shipping ?? null
      // Stripe copies the token's shipping onto the intent; read the token itself if it ever does not.
      if (!shipping?.address && pi.metadata?.confirmation_token) {
        shipping = (await stripe.confirmationTokens.retrieve(pi.metadata.confirmation_token)).shipping ?? null
      }
      const a = shipping?.address
      return {
        intentId: pi.id,
        status: pi.status,
        email: (pm?.billing_details?.email ?? pi.receipt_email ?? '').trim(),
        name: shipping?.name ?? pm?.billing_details?.name ?? null,
        phone: shipping?.phone ?? pm?.billing_details?.phone ?? null,
        shippingAddress: {
          ...(shipping?.name ? { name: shipping.name } : {}),
          ...(a?.line1 ? { line1: a.line1 } : {}),
          ...(a?.line2 ? { line2: a.line2 } : {}),
          ...(a?.city ? { city: a.city } : {}),
          ...(a?.state ? { state: a.state } : {}),
          ...(a?.postal_code ? { postalCode: a.postal_code } : {}),
          ...(a?.country ? { country: a.country.toUpperCase() } : {}),
        },
        amount: { amount: pi.amount, currency: pi.currency.toLowerCase() },
        items: decodeItems(pi.metadata?.items),
        orderId: pi.metadata?.order_id || null,
      }
    },

    async attach(intentId, order, ctx) {
      await stripe.paymentIntents.update(intentId, {
        metadata: { order_id: order.id, order_number: order.number },
        description: describeOrder(order, ctx),
        receipt_email: order.customer.email,
      })
      await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: intentId })
    },

    async capture(intentId) {
      try {
        await stripe.paymentIntents.capture(intentId, {}, { idempotencyKey: `express-capture-${intentId}` })
      } catch (e) {
        // Already captured (a repeated request): read it back below instead of failing.
        if ((e as { code?: string })?.code !== 'payment_intent_unexpected_state') throw e
      }
      const pi = await stripe.paymentIntents.retrieve(intentId, { expand: [...SETTLEMENT_EXPAND] })
      return pi.status === 'succeeded' ? [{ ...paidFromIntent(pi), ...settlementFields(pi) } as PaymentEvent] : []
    },

    async release(intentId) {
      try {
        await stripe.paymentIntents.cancel(intentId, { cancellation_reason: 'abandoned' })
      } catch (e) {
        console.warn('stripe express: could not release hold', intentId, e instanceof Error ? e.message : String(e))
      }
    },

    async intent(order, ctx) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: order.total.amount,
          currency: order.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: { ...metadataFor(order), checkout: EXPRESS },
          description: describeOrder(order, ctx),
          receipt_email: order.customer.email,
          // No `shipping` here. The Express Checkout Element sends the wallet's address with the
          // confirmation, and Stripe refuses to let a publishable key change shipping a secret or
          // restricted key set: every express payment failed with payment_intent_invalid_parameter
          // ("The shipping information on this PaymentIntent was last set with a restricted key")
          // before reaching the card. The address still lands on the intent, from the wallet.
        },
        { idempotencyKey: `express-${order.id}-${order.updatedAt}` }
      )
      if (!pi.client_secret) throw new Error(`Stripe PaymentIntent ${pi.id} has no client secret`)
      await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: pi.id })
      return { clientSecret: pi.client_secret, paymentIntentId: pi.id }
    },
  }
}

/** At most 10 entries, Stripe's 500-character values: attribution must never fail a payment. */
function limitMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).slice(0, 10).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 500)]))
}

/** Items on the hold, as `[[sku, quantity], …]` JSON in one metadata value. */
function encodeItems(items: CheckoutItem[]): string {
  const value = JSON.stringify(items.map((i) => [i.sku, i.quantity]))
  if (value.length > 500) throw new Error('Too many items for express checkout')
  return value
}

function decodeItems(value: string | undefined): CheckoutItem[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && Number.isInteger(x[1])).map(([sku, quantity]) => ({ sku, quantity })) : []
  } catch {
    return []
  }
}

function orderIdOf(session: Stripe.Checkout.Session): string | null {
  return session.client_reference_id ?? session.metadata?.order_id ?? null
}

function paidEvent(session: Stripe.Checkout.Session): PaymentEvent {
  const orderId = orderIdOf(session)
  if (!orderId) return { type: 'ignored', reason: `session ${session.id} has no order id` }
  const currency = (session.currency ?? 'usd').toLowerCase()
  const discount = session.total_details?.amount_discount ?? 0
  const tax = session.total_details?.amount_tax ?? 0
  const reference = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? session.id
  return {
    type: 'paid',
    orderId,
    provider: PROVIDER,
    reference,
    methodLabel: labelFor(session.payment_method_types?.[0]),
    paidAt: new Date().toISOString(),
    ...(typeof session.amount_total === 'number' ? { amount: { amount: session.amount_total, currency } } : {}),
    adjustments: {
      discount: { amount: discount, currency },
      tax: { amount: tax, currency },
      ...(typeof session.amount_total === 'number' ? { total: { amount: session.amount_total, currency } } : {}),
    },
  }
}

function paidFromIntent(pi: Stripe.PaymentIntent): PaymentEvent {
  const orderId = pi.metadata?.order_id
  if (!orderId) return { type: 'ignored', reason: `payment intent ${pi.id} has no order id` }
  const currency = pi.currency.toLowerCase()
  const received = pi.amount_received || pi.amount
  return {
    type: 'paid',
    orderId,
    provider: PROVIDER,
    reference: pi.id,
    methodLabel: labelFor(pi.payment_method_types?.[0]),
    paidAt: new Date().toISOString(),
    amount: { amount: received, currency },
    adjustments: { total: { amount: received, currency } },
  }
}

function labelFor(type: string | undefined): string {
  switch (type) {
    case undefined:
    case 'card':
      return 'Card'
    case 'link':
      return 'Link'
    case 'us_bank_account':
      return 'Bank account'
    default:
      return type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  }
}

/** Map a Stripe event to store events. Exported for tests. */
export function eventsFromStripe(event: Stripe.Event): PaymentEvent[] {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      if (session.payment_status !== 'paid') return [{ type: 'ignored', reason: `session ${session.id} is ${session.payment_status}` }]
      return [paidEvent(session)]
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object
      const orderId = orderIdOf(session)
      if (!orderId) return [{ type: 'ignored', reason: `session ${session.id} has no order id` }]
      const reference = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null
      return [{ type: 'failed', orderId, provider: PROVIDER, reference, reason: 'async payment failed' }]
    }
    case 'payment_intent.succeeded': {
      // Only express intents: hosted Checkout's intents carry order_id too, and their session event already paid them.
      const pi = event.data.object
      if (pi.metadata?.checkout !== EXPRESS) return [{ type: 'ignored', reason: `payment intent ${pi.id} belongs to a Checkout session` }]
      return [paidFromIntent(pi)]
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object
      if (pi.metadata?.checkout !== EXPRESS) return [{ type: 'ignored', reason: `payment intent ${pi.id} belongs to a Checkout session` }]
      if (!pi.metadata.order_id) return [{ type: 'ignored', reason: `payment intent ${pi.id} has no order id` }]
      return [{ type: 'failed', orderId: pi.metadata.order_id, provider: PROVIDER, reference: pi.id, reason: pi.last_payment_error?.code ?? 'payment failed' }]
    }
    case 'charge.refunded': {
      const charge = event.data.object
      if (!charge.refunded) return [{ type: 'ignored', reason: `charge ${charge.id} is only partially refunded` }]
      const reference = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null
      return [{ type: 'refunded', orderId: charge.metadata?.order_id ?? null, provider: PROVIDER, reference }]
    }
    default:
      return [{ type: 'ignored', reason: `unhandled event ${event.type}` }]
  }
}
