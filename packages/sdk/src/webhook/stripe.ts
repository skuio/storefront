import type Stripe from 'stripe'
import type { Money, StorefrontOrder } from '../types.js'

export type StorefrontEvent =
  | { type: 'order.completed'; order: StorefrontOrder; raw: Stripe.Event }
  | { type: 'ignored'; stripeType: string; raw: Stripe.Event }

export interface ParseStripeWebhookOptions {
  stripe: Stripe
  payload: string
  signature: string
  secret: string
}

export class WebhookSignatureError extends Error {
  constructor(cause: unknown) {
    super('Stripe webhook signature verification failed')
    this.name = 'WebhookSignatureError'
    this.cause = cause
  }
}

/**
 * Verify a Stripe webhook and translate it into a processor-neutral event.
 *
 * Uses the async verifier because edge runtimes only expose WebCrypto. On a
 * `checkout.session.completed` the session is re-fetched with line items
 * expanded — the event payload alone does not carry them.
 */
export async function parseStripeWebhook(opts: ParseStripeWebhookOptions): Promise<StorefrontEvent> {
  let event: Stripe.Event
  try {
    event = await opts.stripe.webhooks.constructEventAsync(opts.payload, opts.signature, opts.secret)
  } catch (error) {
    throw new WebhookSignatureError(error)
  }

  if (event.type !== 'checkout.session.completed') {
    return { type: 'ignored', stripeType: event.type, raw: event }
  }

  const session = await opts.stripe.checkout.sessions.retrieve(event.data.object.id, {
    expand: ['line_items', 'line_items.data.price.product'],
  })

  return { type: 'order.completed', order: orderFromSession(session), raw: event }
}

/** Also used by success pages, which have a session but no webhook. */
export function orderFromSession(session: Stripe.Checkout.Session): StorefrontOrder {
  const currency = (session.currency ?? 'usd').toUpperCase()
  const m = (amount: number | null | undefined): Money => ({ amount: amount ?? 0, currency })

  const lines = (session.line_items?.data ?? []).map((li) => {
    const product = li.price?.product
    const sku =
      (typeof product === 'object' && product && 'metadata' in product
        ? (product.metadata as Record<string, string>).sku
        : undefined) ?? '(unknown)'
    return {
      sku,
      name: li.description ?? sku,
      quantity: li.quantity ?? 1,
      unitPrice: m(li.price?.unit_amount),
      total: m(li.amount_total),
    }
  })

  const ship = session.collected_information?.shipping_details
  const shippingAddress = ship
    ? {
        name: ship.name ?? undefined,
        line1: ship.address?.line1 ?? undefined,
        line2: ship.address?.line2 ?? undefined,
        city: ship.address?.city ?? undefined,
        state: ship.address?.state ?? undefined,
        postalCode: ship.address?.postal_code ?? undefined,
        country: ship.address?.country ?? undefined,
      }
    : undefined

  return {
    reference: referenceFromSessionId(session.id),
    processor: 'stripe',
    processorSessionId: session.id,
    processorPaymentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id,
    subtotal: m(session.amount_subtotal),
    shipping: m(session.shipping_cost?.amount_total),
    total: m(session.amount_total),
    lines,
    customer: {
      name: session.customer_details?.name ?? undefined,
      email: session.customer_details?.email ?? undefined,
      phone: session.customer_details?.phone ?? undefined,
    },
    shippingAddress,
    metadata: { ...(session.metadata ?? {}) },
    createdAt: new Date(session.created * 1000).toISOString(),
  }
}

/** `cs_test_a1B2c3...` -> `A1B2C3D4E5F6`. Stable, short, safe to read aloud on the phone. */
export function referenceFromSessionId(id: string): string {
  return id
    .replace(/^cs_(test|live)_/, '')
    .slice(0, 12)
    .toUpperCase()
}
