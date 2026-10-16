import type { Address, Fulfillment, Order, OrderLine, OrderStatus, PaymentStatus } from '../types'
import { parseJson } from './context'

export interface OrderRow {
  id: string
  number: number
  status: string
  payment_status: string
  payment_provider: string | null
  payment_reference: string | null
  payment_method_label: string | null
  paid_at: string | null
  currency: string
  subtotal: number
  shipping: number
  tax: number
  discount: number
  total: number
  customer_id: string
  email: string
  customer_name: string | null
  customer_phone: string | null
  shipping_address_json: string
  billing_address_json: string | null
  shipping_method_code: string | null
  shipping_method_name: string | null
  external_reference: string | null
  notes: string | null
  metadata_json: string
  access_key: string
  created_at: string
  updated_at: string
  cancelled_at: string | null
  discount_code: string | null
  discount_partner: string | null
  partner_commission: number
}

export interface OrderLineRow {
  id: string
  order_id: string
  sku: string
  name: string
  quantity: number
  unit_amount: number
  total_amount: number
  fulfilled_quantity: number
  image_url: string | null
  position: number
}

export interface FulfillmentRow {
  id: string
  order_id: string
  external_id: string
  carrier: string | null
  service: string | null
  tracking_number: string | null
  tracking_url: string | null
  shipped_at: string | null
  notified_at: string | null
  created_at: string
}

export interface FulfillmentLineRow {
  fulfillment_id: string
  sku: string
  quantity: number
}

export const ORDER_SELECT = `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone FROM orders o JOIN customers c ON c.id = o.customer_id`

/** Strip undefined so an address stored as JSON round-trips cleanly. */
export function cleanAddress(a: Address | null | undefined): Address | null {
  if (!a) return null
  const out: Address = {}
  for (const key of ['name', 'line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const) {
    const v = a[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim()
  }
  return out
}

export function rowToLine(r: OrderLineRow, currency: string): OrderLine {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    quantity: r.quantity,
    unitAmount: { amount: r.unit_amount, currency },
    totalAmount: { amount: r.total_amount, currency },
    fulfilledQuantity: r.fulfilled_quantity,
    ...(r.image_url ? { image: r.image_url } : {}),
  }
}

export function rowToFulfillment(r: FulfillmentRow, lines: FulfillmentLineRow[]): Fulfillment {
  return {
    id: r.id,
    externalId: r.external_id,
    carrier: r.carrier,
    service: r.service,
    trackingNumber: r.tracking_number,
    trackingUrl: r.tracking_url,
    shippedAt: r.shipped_at,
    lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
    createdAt: r.created_at,
  }
}

export function rowToOrder(r: OrderRow, lines: OrderLineRow[], fulfillments: Fulfillment[]): Order {
  const money = (amount: number) => ({ amount, currency: r.currency })
  return {
    id: r.id,
    number: String(r.number),
    status: r.status as OrderStatus,
    payment: {
      status: r.payment_status as PaymentStatus,
      provider: r.payment_provider,
      reference: r.payment_reference,
      methodLabel: r.payment_method_label,
      paidAt: r.paid_at,
    },
    currency: r.currency,
    subtotal: money(r.subtotal),
    shipping: money(r.shipping),
    tax: money(r.tax),
    discount: money(r.discount),
    discountCode: r.discount_code ?? null,
    partner: r.discount_partner ? { id: r.discount_partner, commission: money(r.partner_commission ?? 0) } : null,
    total: money(r.total),
    customer: { id: r.customer_id, email: r.email, name: r.customer_name, phone: r.customer_phone },
    shippingAddress: parseJson<Address>(r.shipping_address_json, {}),
    billingAddress: r.billing_address_json ? parseJson<Address | null>(r.billing_address_json, null) : null,
    shippingMethod: r.shipping_method_code && r.shipping_method_name ? { code: r.shipping_method_code, name: r.shipping_method_name } : null,
    lines: lines.map((l) => rowToLine(l, r.currency)),
    fulfillments,
    externalReference: r.external_reference,
    notes: r.notes,
    metadata: parseJson<Record<string, string>>(r.metadata_json, {}),
    accessKey: r.access_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
  }
}
