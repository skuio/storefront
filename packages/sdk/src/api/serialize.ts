import type { CategoryRecord, ProductRecord } from '../store/catalog'
import type { Address, Fulfillment, Money, Order, QuoteStatus, StoreQuote } from '../types'

export interface ApiMoney {
  amount: number
  currency: string
}

export interface ApiAddress {
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
}

export interface ApiFulfillment {
  id: string
  external_id: string
  carrier: string | null
  service: string | null
  tracking_number: string | null
  tracking_url: string | null
  shipped_at: string | null
  lines: { sku: string; quantity: number }[]
  created_at: string
}

export interface ApiOrderPayment {
  status: Order['payment']['status']
  provider: string | null
  reference: string | null
  method_label: string | null
  paid_at: string | null
  /** What the processor captured for this order. Null until a processor adapter reports it. */
  amount_received: ApiMoney | null
  /** What the processor kept, in its settlement currency. Null until known. */
  fee: ApiMoney | null
  /** amount_received minus fee, in the settlement currency. Null until known. */
  net: ApiMoney | null
  /** The processor's charge / capture id (Stripe `ch_…`, PayPal capture id). */
  transaction_id: string | null
  /** When the store recorded the fee (ISO 8601). */
  fee_reported_at: string | null
}

export interface ApiOrder {
  id: string
  number: string
  status: Order['status']
  payment: ApiOrderPayment
  currency: string
  subtotal: ApiMoney
  shipping: ApiMoney
  tax: ApiMoney
  discount: ApiMoney
  /** The store discount code the buyer used, upper case. Partner and commission stay in the store. */
  discount_code: string | null
  total: ApiMoney
  customer: { id: string; email: string; name: string | null; phone: string | null }
  shipping_address: ApiAddress
  billing_address: ApiAddress | null
  shipping_method: { code: string; name: string } | null
  lines: { id: string; sku: string; name: string; quantity: number; unit_amount: ApiMoney; total_amount: ApiMoney; fulfilled_quantity: number }[]
  fulfillments: ApiFulfillment[]
  external_reference: string | null
  notes: string | null
  metadata: Record<string, string>
  created_at: string
  updated_at: string
  paid_at: string | null
  cancelled_at: string | null
}

export interface ApiQuote {
  id: string
  /** With the store's quote prefix: "Q1001". */
  number: string
  status: QuoteStatus
  currency: string
  customer: { id: string; email: string; name: string | null; phone: string | null }
  company: string | null
  message: string | null
  shipping_address: ApiAddress | null
  lines: { id: string; sku: string; name: string; quantity: number; list_amount: ApiMoney | null; unit_amount: ApiMoney | null; total_amount: ApiMoney | null }[]
  subtotal: ApiMoney | null
  shipping: ApiMoney | null
  tax: ApiMoney | null
  total: ApiMoney | null
  note: string | null
  expires_at: string | null
  external_reference: string | null
  /** The order the buyer's acceptance placed; it also arrives through GET /orders with `metadata.quote_id`. */
  order_id: string | null
  decline_reason: string | null
  metadata: Record<string, string>
  created_at: string
  updated_at: string
  quoted_at: string | null
  accepted_at: string | null
  declined_at: string | null
  cancelled_at: string | null
}

export interface ApiProduct {
  sku: string
  name: string
  slug: string
  description_html: string | null
  short_description_html: string | null
  price: ApiMoney
  compare_at: ApiMoney | null
  attributes: Record<string, string>
  active: boolean
  position: number
  legacy_path: string | null
  categories: { id: string; slug: string | null; name: string | null }[]
  images: { url: string; alt: string | null; position: number }[]
  inventory: { available: number; allow_backorder: boolean; updated_at: string } | null
  created_at: string
  updated_at: string
}

export interface ApiCategory {
  id: string
  parent_id: string | null
  slug: string
  name: string
  description_html: string | null
  position: number
  product_count: number
  created_at: string
  updated_at: string
}

const money = (m: Money): ApiMoney => ({ amount: m.amount, currency: m.currency.toUpperCase() })

const address = (a: Address | null): ApiAddress | null =>
  a
    ? {
        name: a.name ?? null,
        line1: a.line1 ?? null,
        line2: a.line2 ?? null,
        city: a.city ?? null,
        state: a.state ?? null,
        postal_code: a.postalCode ?? null,
        country: a.country ?? null,
      }
    : null

export function serializeFulfillment(f: Fulfillment): ApiFulfillment {
  return {
    id: f.id,
    external_id: f.externalId,
    carrier: f.carrier,
    service: f.service,
    tracking_number: f.trackingNumber,
    tracking_url: f.trackingUrl,
    shipped_at: f.shippedAt,
    lines: f.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
    created_at: f.createdAt,
  }
}

/**
 * The Store API's view of an order. `access_key` never leaves the store. `number` is the human number the buyer
 * sees, with the store's prefix (VLD4200), so the consumer shows the same number.
 */
export function serializeOrder(o: Order, numberPrefix = ''): ApiOrder {
  return {
    id: o.id,
    number: `${numberPrefix}${o.number}`,
    status: o.status,
    payment: {
      status: o.payment.status,
      provider: o.payment.provider,
      reference: o.payment.reference,
      method_label: o.payment.methodLabel,
      paid_at: o.payment.paidAt,
      amount_received: o.payment.amountReceived ? money(o.payment.amountReceived) : null,
      fee: o.payment.fee ? money(o.payment.fee) : null,
      net: o.payment.net ? money(o.payment.net) : null,
      transaction_id: o.payment.transactionId,
      fee_reported_at: o.payment.feeReportedAt,
    },
    currency: o.currency.toUpperCase(),
    subtotal: money(o.subtotal),
    shipping: money(o.shipping),
    tax: money(o.tax),
    discount: money(o.discount),
    discount_code: o.discountCode,
    total: money(o.total),
    customer: { id: o.customer.id, email: o.customer.email, name: o.customer.name, phone: o.customer.phone },
    shipping_address: address(o.shippingAddress) ?? { name: null, line1: null, line2: null, city: null, state: null, postal_code: null, country: null },
    billing_address: address(o.billingAddress),
    shipping_method: o.shippingMethod,
    lines: o.lines.map((l) => ({
      id: l.id,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unit_amount: money(l.unitAmount),
      total_amount: money(l.totalAmount),
      fulfilled_quantity: l.fulfilledQuantity,
    })),
    fulfillments: o.fulfillments.map(serializeFulfillment),
    external_reference: o.externalReference,
    notes: o.notes,
    metadata: o.metadata,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    paid_at: o.paidAt,
    cancelled_at: o.cancelledAt,
  }
}

const maybeMoney = (m: Money | null): ApiMoney | null => (m ? money(m) : null)

/** The Store API's view of a quote. `access_key` never leaves the store. */
export function serializeQuote(q: StoreQuote, numberPrefix = ''): ApiQuote {
  return {
    id: q.id,
    number: `${numberPrefix}${q.number}`,
    status: q.status,
    currency: q.currency.toUpperCase(),
    customer: { id: q.customer.id, email: q.customer.email, name: q.customer.name, phone: q.customer.phone },
    company: q.company,
    message: q.message,
    shipping_address: address(q.shippingAddress),
    lines: q.lines.map((l) => ({
      id: l.id,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      list_amount: maybeMoney(l.listAmount),
      unit_amount: maybeMoney(l.unitAmount),
      total_amount: maybeMoney(l.totalAmount),
    })),
    subtotal: maybeMoney(q.subtotal),
    shipping: maybeMoney(q.shipping),
    tax: maybeMoney(q.tax),
    total: maybeMoney(q.total),
    note: q.offerNote,
    expires_at: q.expiresAt,
    external_reference: q.externalReference,
    order_id: q.orderId,
    decline_reason: q.declineReason,
    metadata: q.metadata,
    created_at: q.createdAt,
    updated_at: q.updatedAt,
    quoted_at: q.quotedAt,
    accepted_at: q.acceptedAt,
    declined_at: q.declinedAt,
    cancelled_at: q.cancelledAt,
  }
}

/**
 * Maps a stored image src to the public URL a consumer can load. Return null
 * (or undefined) to fall back to the default: an absolute URL as-is, anything
 * else resolved against the request origin.
 */
export type ImageUrlResolver = (src: string) => string | null | undefined

export interface SerializeProductOptions {
  /** The store's own image resolver; see StoreApiOptions.imageUrl. */
  imageUrl?: ImageUrlResolver
  /** The origin relative srcs resolve against when the resolver has no answer ("https://store.example"). */
  origin?: string
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i

/**
 * The absolute URL the Store API reports for an image. The store's resolver
 * wins; without one (or when it returns null) an absolute URL passes through
 * unchanged and a relative path or bare filename is resolved against the
 * request origin. Resolving a bare filename only produces a loadable URL when
 * the store serves the file at that path — stores that fingerprint their
 * assets must pass a resolver.
 */
export function absoluteImageUrl(src: string, options: SerializeProductOptions = {}): string {
  const url = options.imageUrl?.(src) || src
  if (ABSOLUTE.test(url) || !options.origin) return url
  try {
    return new URL(url, `${options.origin.replace(/\/+$/, '')}/`).href
  } catch {
    return url
  }
}

/** The Store API's view of a catalog product — the stored row, not the shopper projection. */
export function serializeProduct(p: ProductRecord, options: SerializeProductOptions = {}): ApiProduct {
  return {
    sku: p.sku,
    name: p.name,
    slug: p.slug,
    description_html: p.descriptionHtml,
    short_description_html: p.shortDescriptionHtml,
    price: money(p.price),
    compare_at: p.compareAtPrice ? money(p.compareAtPrice) : null,
    attributes: p.attributes,
    active: p.active,
    position: p.position,
    legacy_path: p.legacyPath,
    categories: p.categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
    images: p.images.map((i) => ({ url: absoluteImageUrl(i.url, options), alt: i.alt, position: i.position })),
    inventory: p.inventory ? { available: p.inventory.available, allow_backorder: p.inventory.allowBackorder, updated_at: p.inventory.updatedAt } : null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  }
}

export function serializeCategory(c: CategoryRecord): ApiCategory {
  return {
    id: c.id,
    parent_id: c.parentId,
    slug: c.slug,
    name: c.name,
    description_html: c.descriptionHtml,
    position: c.position,
    product_count: c.productCount,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  }
}
