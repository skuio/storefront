import type { CatalogProvider } from '../provider.js'
import type {
  Availability,
  Category,
  Checkout,
  CheckoutRequest,
  Money,
  Product,
} from '../types.js'

export interface SkuioProviderOptions {
  /** Tenant origin, e.g. https://acme.sku.io — no trailing slash. */
  tenant: string
  /**
   * A storefront-scoped token (`sf_live_…` / `sf_test_…`): read catalogue,
   * read availability, create checkout. Never an admin personal access token —
   * the API rejects those, and one must never be deployed to a storefront.
   */
  storefrontToken: string
  /** Injectable for tests and for runtimes with their own fetch. */
  fetch?: typeof fetch
  /** Page size for catalogue reads. Default 100, max 200. */
  pageSize?: number
}

export class SkuioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'SkuioApiError'
  }
}

// -- wire shapes (the OpenAPI contract in docs/api/storefront-v1.openapi.yaml) --

interface WireMoney {
  amount: number
  currency: string
}
interface WireAvailability {
  status: Availability['status']
  expected_at?: string | null
  updated_at?: string
}
interface WireImage {
  url: string
  alt?: string | null
}
interface WireCategory {
  id: string
  name: string
  slug: string
  parent_id: string | null
  description_html?: string | null
  image?: WireImage | null
  position?: number
}
interface WireProduct {
  id: string
  sku: string
  name: string
  slug: string
  description_html?: string | null
  short_description_html?: string | null
  price: WireMoney
  compare_at_price?: WireMoney | null
  category_ids: string[]
  images: WireImage[]
  availability: WireAvailability
  attributes?: Record<string, string>
  updated_at: string
}
interface WirePage<T> {
  data: T[]
  next_cursor: string | null
}
interface WireCheckout {
  id: string
  status: Checkout['status']
  url: string | null
  processor: Checkout['processor']
  processor_session_id?: string | null
  currency: string
  subtotal: WireMoney
  shipping: WireMoney
  total: WireMoney
  lines: { sku: string; name: string; quantity: number; unit_price: WireMoney; total: WireMoney }[]
  customer?: { name?: string | null; email?: string | null; phone?: string | null } | null
  shipping_address?: {
    name?: string | null
    line1?: string | null
    line2?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
  sales_order_id?: string | null
  metadata?: Record<string, string>
  created_at: string
  expires_at?: string | null
}

const orUndefined = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)

/**
 * Live catalogue and hosted checkout from the SKU.io Storefront API.
 *
 * Implemented and tested against the v1 contract. The endpoints themselves
 * are still being added to SKU.io; until they exist, calls fail with a
 * SkuioApiError from the tenant rather than silently returning nothing.
 */
export function skuioProvider(opts: SkuioProviderOptions): CatalogProvider {
  const base = `${opts.tenant.replace(/\/$/, '')}/api/storefront/v1`
  const doFetch = opts.fetch ?? globalThis.fetch
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 200)

  if (!/^sf_(live|test)_/.test(opts.storefrontToken)) {
    throw new Error(
      '@skuio/storefront: skuioProvider needs a storefront token (sf_live_… / sf_test_…). ' +
        'Admin personal access tokens are rejected by the API and must never be deployed to a storefront.'
    )
  }

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.storefrontToken}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      let code = `http_${res.status}`
      let message = `${res.status} from ${path}`
      let details: unknown
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } }
        code = body.error?.code ?? code
        message = body.error?.message ?? message
        details = body.error?.details
      } catch {
        /* non-JSON error body */
      }
      throw new SkuioApiError(res.status, code, message, details)
    }
    return (await res.json()) as T
  }

  async function paginate<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    do {
      const sep = path.includes('?') ? '&' : '?'
      const page: WirePage<T> = await call(`${path}${sep}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      out.push(...page.data)
      cursor = page.next_cursor
    } while (cursor)
    return out
  }

  return {
    name: 'skuio',

    async categories() {
      const rows = await paginate<WireCategory>('/categories')
      return rows.map(toCategory)
    },

    async products() {
      const rows = await paginate<WireProduct>('/products')
      return rows.map(toProduct)
    },

    async createCheckout(request: CheckoutRequest) {
      const body = {
        items: request.items,
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }
      const wire = await call<WireCheckout>('/checkouts', { method: 'POST', body: JSON.stringify(body) })
      return toCheckout(wire)
    },

    async getCheckout(id: string) {
      return toCheckout(await call<WireCheckout>(`/checkouts/${encodeURIComponent(id)}`))
    },
  }
}

// -- mapping ---------------------------------------------------------------

function toMoney(m: WireMoney): Money {
  return { amount: m.amount, currency: m.currency }
}

export function toCategory(c: WireCategory): Category {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    parentId: c.parent_id,
    ...(c.description_html ? { description: c.description_html } : {}),
    ...(c.image?.url ? { image: c.image.url } : {}),
  }
}

export function toProduct(p: WireProduct): Product {
  const availability: Availability = {
    status: p.availability.status,
    ...(p.availability.expected_at ? { expectedAt: p.availability.expected_at } : {}),
    ...(p.availability.updated_at ? { updatedAt: p.availability.updated_at } : {}),
  }
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    slug: p.slug,
    ...(p.description_html ? { description: p.description_html } : {}),
    ...(p.short_description_html ? { shortDescription: p.short_description_html } : {}),
    price: toMoney(p.price),
    ...(p.compare_at_price ? { compareAtPrice: toMoney(p.compare_at_price) } : {}),
    categoryIds: p.category_ids,
    images: p.images.map((i) => ({ src: i.url, ...(i.alt ? { alt: i.alt } : {}) })),
    // Backorder and preorder are purchasable; only out_of_stock is not.
    available: availability.status !== 'out_of_stock',
    availability,
    ...(p.attributes && Object.keys(p.attributes).length ? { attributes: p.attributes } : {}),
  }
}

export function toCheckout(w: WireCheckout): Checkout {
  return {
    id: w.id,
    status: w.status,
    url: w.url,
    processor: w.processor,
    ...(w.processor_session_id ? { processorSessionId: w.processor_session_id } : {}),
    subtotal: toMoney(w.subtotal),
    shipping: toMoney(w.shipping),
    total: toMoney(w.total),
    lines: w.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitPrice: toMoney(l.unit_price),
      total: toMoney(l.total),
    })),
    ...(w.customer
      ? {
          customer: {
            name: orUndefined(w.customer.name),
            email: orUndefined(w.customer.email),
            phone: orUndefined(w.customer.phone),
          },
        }
      : {}),
    ...(w.shipping_address
      ? {
          shippingAddress: {
            name: orUndefined(w.shipping_address.name),
            line1: orUndefined(w.shipping_address.line1),
            line2: orUndefined(w.shipping_address.line2),
            city: orUndefined(w.shipping_address.city),
            state: orUndefined(w.shipping_address.state),
            postalCode: orUndefined(w.shipping_address.postal_code),
            country: orUndefined(w.shipping_address.country),
          },
        }
      : {}),
    ...(w.sales_order_id ? { salesOrderId: w.sales_order_id } : {}),
    metadata: { ...(w.metadata ?? {}) },
    createdAt: w.created_at,
    ...(w.expires_at ? { expiresAt: w.expires_at } : {}),
  }
}
