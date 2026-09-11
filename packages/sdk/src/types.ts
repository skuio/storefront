/**
 * Core catalogue types.
 *
 * Money is always integer minor units (cents). Nothing in this package ever
 * holds a float price — Stripe wants minor units too, so a float has no reason
 * to exist anywhere in the pipeline.
 */
export interface Money {
  /** Integer minor units, e.g. 109900 for $1,099.00. */
  amount: number
  /** ISO 4217, lower or upper case; normalised to upper on format. */
  currency: string
}

export interface ProductImage {
  /** Path or URL. The rendering layer decides how to resolve it. */
  src: string
  alt?: string
}

export type AvailabilityStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'preorder'

/** Status only, never a count — this data is served to the public internet. */
export interface Availability {
  status: AvailabilityStatus
  /** For backorder/preorder, when stock is expected. */
  expectedAt?: string
  updatedAt?: string
}

export interface Product {
  id: string
  /** Stable merchant identifier. The key used for checkout and order lines. */
  sku: string
  name: string
  slug: string
  description?: string
  shortDescription?: string
  price: Money
  /** Strike-through price when on sale. Only meaningful if greater than price. */
  compareAtPrice?: Money
  /** Categories this product belongs to. The first is treated as primary. */
  categoryIds: string[]
  images: ProductImage[]
  /** Purchasable right now. Derived from `availability` when a provider supplies it. */
  available: boolean
  availability?: Availability
  /** Free-form display attributes (fitment, material, ...). */
  attributes?: Record<string, string>
  /** Where this product lived on a previous platform, for redirects and canonicals. */
  legacyPath?: string
}

export interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  description?: string
  image?: string
}

/** A category placed in its tree, with the derived fields pages need. */
export interface CategoryNode extends Category {
  children: CategoryNode[]
  /** Slugs from the root down to and including this node. */
  path: string[]
  depth: number
  /** Products in this node or any descendant. */
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

export interface OrderLine {
  sku: string
  name: string
  quantity: number
  unitPrice: Money
  total: Money
}

/** A completed, paid order as the storefront understands it — processor-neutral. */
export interface StorefrontOrder {
  /** Short human-readable reference derived from the processor id. */
  reference: string
  processor: 'stripe'
  processorSessionId: string
  processorPaymentId?: string
  subtotal: Money
  shipping: Money
  total: Money
  lines: OrderLine[]
  customer: { name?: string; email?: string; phone?: string }
  shippingAddress?: Address
  metadata: Record<string, string>
  createdAt: string
}

// ---------------------------------------------------------------------------
// Provider-native checkout (SKU.io creates the session on the tenant's processor)
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  items: { sku: string; quantity: number }[]
  /** May contain {CHECKOUT_ID}, replaced by the provider. */
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  /** Restrict the destination countries for this checkout (region enforcement). */
  shipToCountries?: string[]
  metadata?: Record<string, string>
}

export type CheckoutStatus = 'open' | 'completed' | 'expired'

/** A checkout as the provider reports it; on completion it carries the order. */
export interface Checkout {
  id: string
  status: CheckoutStatus
  /** Hosted checkout page; null once completed or expired. */
  url: string | null
  processor: 'stripe' | 'square'
  processorSessionId?: string
  subtotal: Money
  shipping: Money
  total: Money
  lines: OrderLine[]
  customer?: { name?: string; email?: string; phone?: string }
  shippingAddress?: Address
  /** The SKU.io sales order created on completion. */
  salesOrderId?: string
  metadata: Record<string, string>
  createdAt: string
  expiresAt?: string
}
