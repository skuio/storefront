import type { CatalogProvider } from '../provider.js'
import type {
  Address,
  Availability,
  Category,
  Checkout,
  CheckoutRequest,
  Customer,
  CustomerOrder,
  CustomerSession,
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

interface WireAddress {
  name?: string | null
  line1?: string | null
  line2?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
}
interface WireCustomer {
  id: string
  email: string
  name?: string | null
  phone?: string | null
  customer_group?: string | null
  default_shipping_address?: WireAddress | null
}
interface WireCustomerSession {
  session_token: string
  expires_at: string
  customer: WireCustomer
}
interface WireCustomerOrder {
  id: string
  reference: string
  status: CustomerOrder['status']
  fulfillment_status: CustomerOrder['fulfillmentStatus']
  currency: string
  subtotal: WireMoney
  shipping: WireMoney
  total: WireMoney
  lines: { sku: string; name: string; quantity: number; unit_price: WireMoney; total: WireMoney; image?: string | null }[]
  shipments?: { carrier: string; tracking_number: string; tracking_url?: string | null; shipped_at?: string }[]
  shipping_address?: WireAddress | null
  channel?: string
  created_at: string
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
    if (res.status === 202 || res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  async function paginate<T>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    do {
      const sep = path.includes('?') ? '&' : '?'
      const page: WirePage<T> = await call(`${path}${sep}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers ? { headers } : undefined)
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
        ...(request.shipToCountries ? { ship_to_countries: request.shipToCountries } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }
      const wire = await call<WireCheckout>('/checkouts', { method: 'POST', body: JSON.stringify(body) })
      return toCheckout(wire)
    },

    async getCheckout(id: string) {
      return toCheckout(await call<WireCheckout>(`/checkouts/${encodeURIComponent(id)}`))
    },

    customers: {
      async requestSession(email, returnUrl) {
        await call<unknown>('/customers/session', {
          method: 'POST',
          body: JSON.stringify({ email, return_url: returnUrl }),
        })
      },
      async exchange(token) {
        return toSession(await call<WireCustomerSession>('/customers/session/exchange', { method: 'POST', body: JSON.stringify({ token }) }))
      },
      async me(sessionToken) {
        return toCustomer(await call<WireCustomer>('/customers/me', { headers: { 'X-Customer-Session': sessionToken } }))
      },
      async orders(sessionToken) {
        const rows = await paginate<WireCustomerOrder>('/customers/me/orders', { 'X-Customer-Session': sessionToken })
        return rows.map(toCustomerOrder)
      },
      async revoke(sessionToken) {
        await call<unknown>('/customers/session', { method: 'DELETE', headers: { 'X-Customer-Session': sessionToken } })
      },
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

function toAddress(a: WireAddress | null | undefined): Address | undefined {
  if (!a) return undefined
  return {
    name: orUndefined(a.name), line1: orUndefined(a.line1), line2: orUndefined(a.line2), city: orUndefined(a.city),
    state: orUndefined(a.state), postalCode: orUndefined(a.postal_code), country: orUndefined(a.country),
  }
}

export function toCustomer(c: WireCustomer): Customer {
  return {
    id: c.id,
    email: c.email,
    ...(c.name ? { name: c.name } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.customer_group ? { customerGroup: c.customer_group } : {}),
    ...(c.default_shipping_address ? { defaultShippingAddress: toAddress(c.default_shipping_address) } : {}),
  }
}

export function toSession(s: WireCustomerSession): CustomerSession {
  return { sessionToken: s.session_token, expiresAt: s.expires_at, customer: toCustomer(s.customer) }
}

export function toCustomerOrder(o: WireCustomerOrder): CustomerOrder {
  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    fulfillmentStatus: o.fulfillment_status,
    subtotal: toMoney(o.subtotal),
    shipping: toMoney(o.shipping),
    total: toMoney(o.total),
    lines: o.lines.map((l) => ({
      sku: l.sku, name: l.name, quantity: l.quantity, unitPrice: toMoney(l.unit_price), total: toMoney(l.total),
      ...(l.image ? { image: l.image } : {}),
    })),
    shipments: (o.shipments ?? []).map((sh) => ({
      carrier: sh.carrier, trackingNumber: sh.tracking_number,
      ...(sh.tracking_url ? { trackingUrl: sh.tracking_url } : {}),
      ...(sh.shipped_at ? { shippedAt: sh.shipped_at } : {}),
    })),
    ...(o.shipping_address ? { shippingAddress: toAddress(o.shipping_address) } : {}),
    ...(o.channel ? { channel: o.channel } : {}),
    createdAt: o.created_at,
  }
}
