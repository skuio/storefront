/**
 * Shared types for the store platform.
 *
 * Money is always integer minor units: `{ amount: 109900, currency: 'usd' }`
 * is $1,099.00. Nothing in this package ever holds a float price.
 */
export interface Money {
  amount: number
  currency: string
}

export interface ProductImage {
  /** Absolute URL or a basename a store resolves against its own assets. */
  src: string
  alt?: string
}

export type AvailabilityStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'preorder'

export interface Availability {
  status: AvailabilityStatus
  /** Units available when the store tracks stock for this SKU; undefined when it does not. */
  quantity?: number
  expectedAt?: string
  updatedAt?: string
}

export interface Product {
  /** Same value as `sku` in the store database; kept for backwards compatibility with blocks keyed on `id`. */
  id: string
  sku: string
  name: string
  slug: string
  /** HTML. */
  description?: string
  /** HTML. */
  shortDescription?: string
  price: Money
  compareAtPrice?: Money
  categoryIds: string[]
  images: ProductImage[]
  /** Purchasable right now. Derived from availability. */
  available: boolean
  availability?: Availability
  attributes?: Record<string, string>
  position?: number
  /** URL the product had on a previous platform, when a store reproduces it. */
  legacyPath?: string
}

export interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  description?: string
  image?: ProductImage
  position?: number
}

export interface CategoryNode extends Category {
  children: CategoryNode[]
  /** Slugs from the root to this node. */
  path: string[]
  depth: number
  /** Distinct products in this node and every descendant. */
  productCount: number
}

export interface Address {
  name?: string
  line1?: string
  line2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'processing'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'cancelled'
  | 'refunded'

export type PaymentStatus = 'unpaid' | 'paid' | 'refunded' | 'failed'

export interface OrderPayment {
  status: PaymentStatus
  /** Adapter id: `stripe`, `manual`, … */
  provider: string | null
  /** Processor reference (a PaymentIntent id, a bank transfer note, …). */
  reference: string | null
  methodLabel: string | null
  paidAt: string | null
}

export interface OrderCustomer {
  id: string
  email: string
  name: string | null
  phone: string | null
}

export interface OrderLine {
  id: string
  sku: string
  name: string
  quantity: number
  unitAmount: Money
  totalAmount: Money
  fulfilledQuantity: number
  /** Snapshot of the product's primary image at order time, for the portal. */
  image?: string
}

export interface FulfillmentLine {
  sku: string
  quantity: number
}

export interface Fulfillment {
  id: string
  /** The operations system's shipment id; makes a push idempotent. */
  externalId: string
  carrier: string | null
  service: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  shippedAt: string | null
  lines: FulfillmentLine[]
  createdAt: string
}

export interface ShippingMethod {
  code: string
  name: string
}

export interface Order {
  id: string
  /** Human order number, e.g. "1042". Sequential from 1001. */
  number: string
  status: OrderStatus
  payment: OrderPayment
  currency: string
  subtotal: Money
  shipping: Money
  tax: Money
  discount: Money
  /** The store discount code priced into this order (upper case), or null. */
  discountCode: string | null
  /** The partner the code attributes this order to, and the commission owed at the rate in force when it was placed. */
  partner: { id: string; commission: Money } | null
  total: Money
  customer: OrderCustomer
  shippingAddress: Address
  billingAddress: Address | null
  shippingMethod: ShippingMethod | null
  lines: OrderLine[]
  fulfillments: Fulfillment[]
  /** The operations system's own order number, stamped back through the Store API. */
  externalReference: string | null
  notes: string | null
  metadata: Record<string, string>
  /**
   * Random secret that lets the buyer who placed the order see its confirmation
   * page without signing in. Never exposed through the Store API.
   */
  accessKey: string
  createdAt: string
  updatedAt: string
  paidAt: string | null
  cancelledAt: string | null
}

export interface Customer {
  id: string
  email: string
  name: string | null
  phone: string | null
  createdAt: string
  updatedAt: string
}

export interface OrderEvent {
  id: number
  orderId: string
  type: string
  data: Record<string, unknown> | null
  createdAt: string
}

/**
 * requested → quoted → accepted (an order exists) | declined | expired → (re-quoted).
 * `cancelled` is the merchant or the operations system withdrawing it.
 */
export type QuoteStatus = 'requested' | 'quoted' | 'accepted' | 'declined' | 'expired' | 'cancelled'

export interface QuoteLine {
  id: string
  sku: string
  name: string
  quantity: number
  /** The catalog price when the buyer asked, for reference; null for a line the offer added off-catalog. */
  listAmount: Money | null
  /** The offered price; null until the quote is priced. */
  unitAmount: Money | null
  totalAmount: Money | null
  image?: string
}

/**
 * A request for quote and, once priced, the offer. The buyer needs no account: a guest's quote is reached
 * through the access-key link emailed to them, a signed-in buyer's also through /account.
 */
export interface StoreQuote {
  id: string
  /** Human quote number without the prefix, e.g. "1001" (shown as Q1001). */
  number: string
  status: QuoteStatus
  currency: string
  customer: OrderCustomer
  company: string | null
  /** What the buyer wrote with the request: lead time, use, delivery constraints. */
  message: string | null
  shippingAddress: Address | null
  lines: QuoteLine[]
  /** Null until priced. */
  subtotal: Money | null
  shipping: Money | null
  tax: Money | null
  total: Money | null
  /** The merchant's note with the offer (terms, lead time). */
  offerNote: string | null
  /** When the offer lapses; null for an open-ended offer or an unpriced request. */
  expiresAt: string | null
  /** The operations system's own quote number, stamped back through the Store API. */
  externalReference: string | null
  /** The order placed when the buyer accepted. */
  orderId: string | null
  declineReason: string | null
  metadata: Record<string, string>
  /** Secret in the buyer's emailed link; never exposed through the Store API. */
  accessKey: string
  createdAt: string
  updatedAt: string
  quotedAt: string | null
  acceptedAt: string | null
  declinedAt: string | null
  cancelledAt: string | null
}
