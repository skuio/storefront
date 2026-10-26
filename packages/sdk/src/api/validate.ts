import type { CategoryInput, ProductInput } from '../store/catalog'
import type { InventoryItemInput } from '../store/inventory'
import type { FulfillmentInput } from '../store/orders'
import type { QuoteOfferInput } from '../store/quotes'
import type { Money } from '../types'

export class ValidationError extends Error {
  readonly details: Record<string, string>
  constructor(message: string, details: Record<string, string>) {
    super(message)
    this.name = 'ValidationError'
    this.details = details
  }
}

type Details = Record<string, string>

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function str(details: Details, obj: Record<string, unknown>, key: string, path: string, opts: { required?: boolean; max?: number; nullable?: boolean } = {}): string | null | undefined {
  const v = obj[key]
  if (v === undefined) {
    if (opts.required) details[path] = 'is required'
    return undefined
  }
  if (v === null) {
    if (opts.required && !opts.nullable) details[path] = 'is required'
    return opts.nullable || !opts.required ? null : undefined
  }
  if (!isString(v)) {
    details[path] = 'must be a string'
    return undefined
  }
  if (opts.required && !v.trim()) details[path] = 'is required'
  if (opts.max && v.length > opts.max) details[path] = `must be at most ${opts.max} characters`
  return v
}

function moneyField(details: Details, v: unknown, path: string, opts: { required?: boolean; nullable?: boolean } = {}): Money | null | undefined {
  if (v === undefined) {
    if (opts.required) details[path] = 'is required'
    return undefined
  }
  if (v === null) {
    if (!opts.nullable) details[path] = 'is required'
    return null
  }
  if (!isObject(v) || !isInt(v.amount) || !isString(v.currency) || v.currency.length !== 3) {
    details[path] = 'must be { amount: integer minor units, currency: ISO 4217 }'
    return undefined
  }
  if (v.amount < 0) details[path] = 'must not be negative'
  return { amount: v.amount, currency: v.currency }
}

function isoDate(details: Details, v: unknown, path: string): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (!isString(v) || Number.isNaN(Date.parse(v))) {
    details[path] = 'must be an ISO-8601 timestamp'
    return undefined
  }
  return new Date(v).toISOString()
}

function finish(details: Details, message: string): void {
  if (Object.keys(details).length) throw new ValidationError(message, details)
}

export interface ListQuery {
  updatedSince: string | null
  cursor: string | null
  limit: number
  active: boolean | null
}

/**
 * Query string for the catalog list endpoints. Out-of-range values are a 422
 * rather than a silent clamp, so a caller paging with a bad limit is told.
 */
export function validateListQuery(
  params: URLSearchParams,
  opts: { defaultLimit: number; maxLimit: number; allowUpdatedSince?: boolean; allowActive?: boolean }
): ListQuery {
  const details: Details = {}
  const limitRaw = params.get('limit')
  const limit = limitRaw ? Number(limitRaw) : opts.defaultLimit
  if (limitRaw && (!Number.isInteger(limit) || limit < 1 || limit > opts.maxLimit)) {
    details.limit = `must be an integer from 1 to ${opts.maxLimit}`
  }

  const updatedSinceRaw = opts.allowUpdatedSince ? params.get('updated_since') : null
  if (updatedSinceRaw && Number.isNaN(Date.parse(updatedSinceRaw))) details.updated_since = 'must be an ISO-8601 timestamp'

  const activeRaw = opts.allowActive ? params.get('active') : null
  let active: boolean | null = null
  if (activeRaw !== null) {
    if (activeRaw === 'true') active = true
    else if (activeRaw === 'false') active = false
    else details.active = 'must be true or false'
  }

  finish(details, 'Invalid query')
  return {
    updatedSince: updatedSinceRaw ? new Date(updatedSinceRaw).toISOString() : null,
    cursor: params.get('cursor'),
    limit: Number.isInteger(limit) ? limit : opts.defaultLimit,
    active,
  }
}

export function validateProducts(body: Record<string, unknown>): ProductInput[] {
  const details: Details = {}
  const list = body.products
  if (!Array.isArray(list)) {
    details.products = 'must be an array'
    finish(details, 'Invalid products payload')
  }
  const items = list as unknown[]
  if (items.length > 200) details.products = 'must have at most 200 items'
  const out: ProductInput[] = []
  const seen = new Set<string>()
  items.forEach((raw, i) => {
    const p = `products.${i}`
    if (!isObject(raw)) {
      details[p] = 'must be an object'
      return
    }
    const sku = str(details, raw, 'sku', `${p}.sku`, { required: true, max: 64 })
    const name = str(details, raw, 'name', `${p}.name`, { required: true, max: 255 })
    const slug = str(details, raw, 'slug', `${p}.slug`, { max: 255, nullable: true })
    const description = str(details, raw, 'description_html', `${p}.description_html`, { nullable: true })
    const short = str(details, raw, 'short_description_html', `${p}.short_description_html`, { nullable: true })
    const price = moneyField(details, raw.price, `${p}.price`, { required: true })
    const compare = moneyField(details, raw.compare_at_price, `${p}.compare_at_price`, { nullable: true })
    if (sku && seen.has(sku)) details[`${p}.sku`] = 'appears more than once'
    if (sku) seen.add(sku)
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) details[`${p}.slug`] = 'must be lower-case letters, digits and hyphens'

    const images: { url: string; alt?: string | null }[] = []
    if (raw.images !== undefined) {
      if (!Array.isArray(raw.images)) details[`${p}.images`] = 'must be an array'
      else
        raw.images.forEach((img, j) => {
          if (!isObject(img) || !isString(img.url) || !img.url.trim()) details[`${p}.images.${j}.url`] = 'is required'
          else images.push({ url: img.url, alt: isString(img.alt) ? img.alt : null })
        })
    }
    const categoryIds: string[] = []
    if (raw.category_ids !== undefined) {
      if (!Array.isArray(raw.category_ids) || !raw.category_ids.every(isString)) details[`${p}.category_ids`] = 'must be an array of strings'
      else categoryIds.push(...(raw.category_ids as string[]))
    }
    let attributes: Record<string, string> = {}
    if (raw.attributes !== undefined) {
      if (!isObject(raw.attributes) || !Object.values(raw.attributes).every(isString)) details[`${p}.attributes`] = 'must be an object of strings'
      else attributes = raw.attributes as Record<string, string>
    }
    if (raw.active !== undefined && typeof raw.active !== 'boolean') details[`${p}.active`] = 'must be a boolean'
    if (raw.position !== undefined && !isInt(raw.position)) details[`${p}.position`] = 'must be an integer'

    if (sku && name && price) {
      out.push({
        sku: sku.trim(),
        name: name.trim(),
        slug: slug ?? null,
        description_html: description ?? null,
        short_description_html: short ?? null,
        price,
        compare_at_price: compare ?? null,
        images,
        category_ids: categoryIds,
        attributes,
        active: raw.active === undefined ? true : (raw.active as boolean),
        ...(isInt(raw.position) ? { position: raw.position } : {}),
      })
    }
  })
  finish(details, 'Invalid products payload')
  return out
}

export function validateCategories(body: Record<string, unknown>): CategoryInput[] {
  const details: Details = {}
  const list = body.categories
  if (!Array.isArray(list)) {
    details.categories = 'must be an array'
    finish(details, 'Invalid categories payload')
  }
  const items = list as unknown[]
  if (items.length > 500) details.categories = 'must have at most 500 items'
  const out: CategoryInput[] = []
  const seen = new Set<string>()
  items.forEach((raw, i) => {
    const p = `categories.${i}`
    if (!isObject(raw)) {
      details[p] = 'must be an object'
      return
    }
    const id = str(details, raw, 'id', `${p}.id`, { required: true, max: 64 })
    const name = str(details, raw, 'name', `${p}.name`, { required: true, max: 255 })
    const slug = str(details, raw, 'slug', `${p}.slug`, { max: 255, nullable: true })
    const parent = str(details, raw, 'parent_id', `${p}.parent_id`, { max: 64, nullable: true })
    const description = str(details, raw, 'description_html', `${p}.description_html`, { nullable: true })
    if (id && seen.has(id)) details[`${p}.id`] = 'appears more than once'
    if (id) seen.add(id)
    if (id && parent && parent === id) details[`${p}.parent_id`] = 'cannot be the category itself'
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) details[`${p}.slug`] = 'must be lower-case letters, digits and hyphens'
    let image: { url: string; alt?: string | null } | null = null
    if (raw.image !== undefined && raw.image !== null) {
      if (!isObject(raw.image) || !isString(raw.image.url)) details[`${p}.image`] = 'must be { url, alt? } or null'
      else image = { url: raw.image.url, alt: isString(raw.image.alt) ? raw.image.alt : null }
    }
    if (raw.position !== undefined && !isInt(raw.position)) details[`${p}.position`] = 'must be an integer'
    if (id && name) {
      out.push({ id: id.trim(), name: name.trim(), slug: slug ?? null, parent_id: parent ?? null, description_html: description ?? null, image, ...(isInt(raw.position) ? { position: raw.position } : {}) })
    }
  })
  finish(details, 'Invalid categories payload')
  return out
}

export function validateInventory(body: Record<string, unknown>): InventoryItemInput[] {
  const details: Details = {}
  const list = body.items
  if (!Array.isArray(list)) {
    details.items = 'must be an array'
    finish(details, 'Invalid inventory payload')
  }
  const items = list as unknown[]
  if (items.length > 500) details.items = 'must have at most 500 items'
  const out: InventoryItemInput[] = []
  items.forEach((raw, i) => {
    const p = `items.${i}`
    if (!isObject(raw)) {
      details[p] = 'must be an object'
      return
    }
    const sku = str(details, raw, 'sku', `${p}.sku`, { required: true, max: 64 })
    if (!isInt(raw.available)) details[`${p}.available`] = 'must be an integer'
    else if (raw.available < 0) details[`${p}.available`] = 'must be a non-negative integer'
    if (raw.allow_backorder !== undefined && typeof raw.allow_backorder !== 'boolean') details[`${p}.allow_backorder`] = 'must be a boolean'
    if (sku && isInt(raw.available) && raw.available >= 0) out.push({ sku: sku.trim(), available: raw.available, allow_backorder: raw.allow_backorder === true })
  })
  finish(details, 'Invalid inventory payload')
  return out
}

export function validateFulfillment(body: Record<string, unknown>): FulfillmentInput {
  const details: Details = {}
  const externalId = str(details, body, 'external_id', 'external_id', { required: true, max: 64 })
  const carrier = str(details, body, 'carrier', 'carrier', { nullable: true, max: 100 })
  const service = str(details, body, 'service', 'service', { nullable: true, max: 100 })
  const trackingNumber = str(details, body, 'tracking_number', 'tracking_number', { nullable: true, max: 100 })
  const trackingUrl = str(details, body, 'tracking_url', 'tracking_url', { nullable: true, max: 2000 })
  if (trackingUrl && !/^https?:\/\//.test(trackingUrl)) details.tracking_url = 'must be an absolute http(s) URL'
  const shippedAt = isoDate(details, body.shipped_at, 'shipped_at')
  if (body.notify_customer !== undefined && typeof body.notify_customer !== 'boolean') details.notify_customer = 'must be a boolean'
  const lines: { sku: string; quantity: number }[] = []
  if (!Array.isArray(body.lines) || body.lines.length === 0) details.lines = 'must be a non-empty array'
  else
    body.lines.forEach((raw, i) => {
      if (!isObject(raw) || !isString(raw.sku) || !raw.sku.trim()) details[`lines.${i}.sku`] = 'is required'
      if (!isObject(raw) || !isInt(raw.quantity) || raw.quantity < 1) details[`lines.${i}.quantity`] = 'must be an integer of at least 1'
      if (isObject(raw) && isString(raw.sku) && isInt(raw.quantity) && raw.quantity >= 1) lines.push({ sku: raw.sku.trim(), quantity: raw.quantity })
    })
  finish(details, 'Invalid fulfillment payload')
  return {
    external_id: externalId!.trim(),
    carrier: carrier ?? null,
    service: service ?? null,
    tracking_number: trackingNumber ?? null,
    tracking_url: trackingUrl ?? null,
    shipped_at: shippedAt ?? null,
    lines,
    notify_customer: body.notify_customer === undefined ? true : (body.notify_customer as boolean),
  }
}

export interface OrderPatch {
  external_reference?: string | null
  status?: 'cancelled'
  payment?: { status: 'paid' | 'refunded' | 'failed'; provider?: string | null; reference?: string | null; paid_at?: string | null }
}

export function validateOrderPatch(body: Record<string, unknown>): OrderPatch {
  const details: Details = {}
  const out: OrderPatch = {}
  if ('external_reference' in body) {
    const ref = str(details, body, 'external_reference', 'external_reference', { nullable: true, max: 64 })
    if (ref !== undefined) out.external_reference = ref
  }
  if (body.status !== undefined) {
    if (body.status !== 'cancelled') details.status = 'can only be set to "cancelled"'
    else out.status = 'cancelled'
  }
  if (body.payment !== undefined) {
    if (!isObject(body.payment)) details.payment = 'must be an object'
    else {
      const p = body.payment
      if (p.status !== 'paid' && p.status !== 'refunded' && p.status !== 'failed') details['payment.status'] = 'must be paid, refunded or failed'
      const provider = str(details, p, 'provider', 'payment.provider', { nullable: true, max: 64 })
      const reference = str(details, p, 'reference', 'payment.reference', { nullable: true, max: 255 })
      const paidAt = isoDate(details, p.paid_at, 'payment.paid_at')
      if (p.status === 'paid' || p.status === 'refunded' || p.status === 'failed') {
        out.payment = { status: p.status, provider: provider ?? null, reference: reference ?? null, paid_at: paidAt ?? null }
      }
    }
  }
  if (!('external_reference' in body) && body.status === undefined && body.payment === undefined) details.body = 'must include external_reference, status or payment'
  finish(details, 'Invalid order patch')
  return out
}

export interface QuotePatch {
  external_reference?: string | null
  status?: 'cancelled'
  offer?: QuoteOfferInput
}

/** `PATCH /quotes/{id}`: stamp a reference, withdraw the quote, or price it (`offer`). */
export function validateQuotePatch(body: Record<string, unknown>): QuotePatch {
  const details: Details = {}
  const out: QuotePatch = {}
  if ('external_reference' in body) {
    const ref = str(details, body, 'external_reference', 'external_reference', { nullable: true, max: 64 })
    if (ref !== undefined) out.external_reference = ref
  }
  if (body.status !== undefined) {
    if (body.status !== 'cancelled') details.status = 'can only be set to "cancelled"'
    else out.status = 'cancelled'
  }
  if (body.offer !== undefined) {
    if (!isObject(body.offer)) details.offer = 'must be an object'
    else {
      const o = body.offer
      const lines: QuoteOfferInput['lines'] = []
      if (!Array.isArray(o.lines) || o.lines.length === 0) details['offer.lines'] = 'must be a non-empty array'
      else
        o.lines.forEach((raw, i) => {
          if (!isObject(raw)) {
            details[`offer.lines.${i}`] = 'must be an object'
            return
          }
          const sku = str(details, raw, 'sku', `offer.lines.${i}.sku`, { required: true, max: 100 })
          const name = str(details, raw, 'name', `offer.lines.${i}.name`, { nullable: true, max: 300 })
          if (!isInt(raw.quantity) || raw.quantity < 1) details[`offer.lines.${i}.quantity`] = 'must be an integer of at least 1'
          const unit = moneyField(details, raw.unit_amount, `offer.lines.${i}.unit_amount`, { required: true })
          if (sku && isInt(raw.quantity) && raw.quantity >= 1 && unit) lines.push({ sku: sku.trim(), name: name ?? null, quantity: raw.quantity, unit_amount: unit })
        })
      const shipping = moneyField(details, o.shipping, 'offer.shipping', { nullable: true })
      const tax = moneyField(details, o.tax, 'offer.tax', { nullable: true })
      const expiresAt = isoDate(details, o.expires_at, 'offer.expires_at')
      const note = str(details, o, 'note', 'offer.note', { nullable: true, max: 4000 })
      if (o.notify_customer !== undefined && typeof o.notify_customer !== 'boolean') details['offer.notify_customer'] = 'must be a boolean'
      out.offer = {
        lines,
        shipping: shipping ?? null,
        tax: tax ?? null,
        expires_at: expiresAt ?? null,
        note: note ?? null,
        notify_customer: o.notify_customer === undefined ? true : (o.notify_customer as boolean),
      }
    }
  }
  if (out.status && out.offer) details.status = 'cannot be combined with an offer'
  if (!('external_reference' in body) && body.status === undefined && body.offer === undefined) details.body = 'must include external_reference, status or offer'
  finish(details, 'Invalid quote patch')
  return out
}
