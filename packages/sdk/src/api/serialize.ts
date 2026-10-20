import type { CategoryRecord, ProductRecord } from '../store/catalog'
import type { Address, Fulfillment, Money, Order } from '../types'

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

export interface ApiOrder {
  id: string
  number: string
  status: Order['status']
  payment: { status: Order['payment']['status']; provider: string | null; reference: string | null; method_label: string | null; paid_at: string | null }
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
    payment: { status: o.payment.status, provider: o.payment.provider, reference: o.payment.reference, method_label: o.payment.methodLabel, paid_at: o.payment.paidAt },
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

/** The Store API's view of a catalogue product — the stored row, not the shopper projection. */
export function serializeProduct(p: ProductRecord): ApiProduct {
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
    images: p.images.map((i) => ({ url: i.url, alt: i.alt, position: i.position })),
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
