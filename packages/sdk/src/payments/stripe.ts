import type Stripe from 'stripe'
import type { Order } from '../types'
import { PaymentWebhookError, type PaymentAdapter, type PaymentContext, type PaymentEvent, type PaymentStart } from './index'

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

/**
 * Stripe hosted Checkout in payment-only mode. The store has already taken
 * the address and shipping choice, so the session carries the order's lines
 * and shipping as fixed amounts and identifies the order by
 * `client_reference_id` / `metadata.order_id`.
 */
export function stripePayments(options: StripePaymentOptions): PaymentAdapter {
  const { stripe } = options

  const metadataFor = (order: Order): Record<string, string> => ({
    order_id: order.id,
    order_number: order.number,
    ...Object.fromEntries(Object.entries(order.metadata).slice(0, 10)),
  })

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
      const a = order.shippingAddress
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: 'payment',
        line_items,
        client_reference_id: order.id,
        customer_email: order.customer.email,
        metadata: metadataFor(order),
        payment_intent_data: {
          metadata: metadataFor(order),
          description: `${ctx.store.config.name} order ${ctx.store.config.orders.numberPrefix}${order.number}`,
          ...(a.line1 && a.country
            ? {
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
            : {}),
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
      return eventsFromStripe(event)
    },

    async verifyReturn(params, order): Promise<PaymentEvent[]> {
      const sessionId = params.get('session_id')
      if (!sessionId) return []
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      if (orderIdOf(session) !== order.id) return []
      return session.payment_status === 'paid' ? [paidEvent(session)] : []
    },
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
