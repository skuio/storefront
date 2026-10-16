import { MAX_CART_LINES } from '../cart'
import { commissionAmount, discountAmount, findDiscount, normalizeDiscountCode, quantityTier, type DiscountCode, type QuantityDiscount } from '../discounts'
import type { DbStatement } from '../db/driver'
import { regionForCountry, shippingForRegion, type ShippingOption } from '../shipping'
import type { Address, Order } from '../types'
import type { CatalogService } from './catalog'
import type { StoreContext } from './context'
import { newId, randomToken } from './crypto'
import { normalizeEmail } from './customers'
import { invalid } from './errors'
import type { EventsService } from './events'
import type { OrdersService } from './orders'
import { cleanAddress } from './rows'

export interface CheckoutItem {
  sku: string
  quantity: number
}

export interface CheckoutInput {
  items: CheckoutItem[]
  email: string
  name?: string | null
  phone?: string | null
  shippingAddress: Address
  billingAddress?: Address | null
  shippingOptionId: string
  /** A discount code the buyer entered or arrived with; validated against the store's configuration. */
  discountCode?: string | null
  notes?: string | null
  metadata?: Record<string, string>
}

export interface PricedLine {
  sku: string
  name: string
  quantity: number
  unitAmount: number
  totalAmount: number
  image: string | null
}

export interface Quote {
  lines: PricedLine[]
  subtotal: number
  /** Minor units off the merchandise subtotal; 0 without a code. */
  discount: number
  /** The code the buyer used, or null. Kept for attribution even when a quantity tier saved more. */
  discountCode: DiscountCode | null
  /** The quantity tier that priced `discount` instead of the code, or null. */
  quantityTier: QuantityDiscount | null
  /** What the code's partner is owed for this order, minor units; 0 without a partner. */
  commission: number
  shipping: number
  total: number
  currency: string
  option: ShippingOption
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class CheckoutService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly catalog: CatalogService,
    private readonly orders: OrdersService,
    private readonly events: EventsService
  ) {}

  /** Shipping options a destination may choose from. */
  optionsForCountry(country: string): ShippingOption[] {
    const region = regionForCountry(this.ctx.config.shipping, this.ctx.config.shipToCountries, country)
    return region ? shippingForRegion(this.ctx.config.shipping, this.ctx.config.shipToCountries, region).options : []
  }

  /**
   * Price a set of lines from the catalogue. Quantities are clamped to the
   * store's per-line maximum; unknown or unavailable SKUs fail validation.
   */
  async quote(items: CheckoutItem[], country: string, shippingOptionId: string, discountCode?: string | null): Promise<Quote> {
    const details: Record<string, string> = {}
    if (!items.length) details.items = 'is empty'
    if (items.length > MAX_CART_LINES) details.items = `has more than ${MAX_CART_LINES} lines`
    const catalog = await this.catalog.load()
    const merged = new Map<string, number>()
    for (const item of items) merged.set(item.sku, (merged.get(item.sku) ?? 0) + clampQuantity(item.quantity, this.ctx.config.checkout.maxQuantity))
    const lines: PricedLine[] = []
    for (const [sku, quantity] of merged) {
      const product = catalog.product(sku)
      if (!product) {
        details[`items.${sku}`] = 'is not a product in this store'
        continue
      }
      if (!product.available) {
        details[`items.${sku}`] = 'is sold out'
        continue
      }
      if (product.price.currency.toLowerCase() !== this.ctx.config.currency.toLowerCase()) {
        details[`items.${sku}`] = 'is priced in another currency'
        continue
      }
      const q = clampQuantity(quantity, this.ctx.config.checkout.maxQuantity)
      lines.push({ sku, name: product.name, quantity: q, unitAmount: product.price.amount, totalAmount: product.price.amount * q, image: product.images[0]?.src ?? null })
    }
    const options = this.optionsForCountry(country)
    if (!options.length) details['shipping_address.country'] = 'is not a country this store ships to'
    const option = options.find((o) => o.id === shippingOptionId)
    if (options.length && !option) details.shipping_option = 'is not available for this destination'
    // A code the buyer sees as applied must still be valid when the order is priced; never drop it silently.
    const code = discountCode && normalizeDiscountCode(discountCode) ? findDiscount(this.ctx.config.discounts, discountCode, new Date(this.ctx.now())) : null
    if (discountCode && normalizeDiscountCode(discountCode) && !code) details.discount_code = 'is not a valid code'
    if (Object.keys(details).length || !option) throw invalid('Checkout could not be priced', details)
    const subtotal = lines.reduce((sum, l) => sum + l.totalAmount, 0)
    const codeOff = code ? discountAmount(code, subtotal) : 0
    const tier = quantityTier(this.ctx.config.quantityDiscounts, lines.reduce((n, l) => n + l.quantity, 0))
    const tierOff = tier ? Math.min(subtotal, Math.round((subtotal * tier.percentOff) / 100)) : 0
    // Never stacked: the larger saving wins. The code still attributes the order either way.
    const discount = Math.max(codeOff, tierOff)
    const commission = code ? commissionAmount(code, subtotal, discount) : 0
    return {
      lines,
      subtotal,
      discount,
      discountCode: code,
      quantityTier: tierOff > codeOff ? tier : null,
      commission,
      shipping: option.price.amount,
      total: subtotal - discount + option.price.amount,
      currency: this.ctx.config.currency,
      option,
    }
  }

  /** Create a pending order the payment adapter can take from here. */
  async createOrder(input: CheckoutInput): Promise<Order> {
    const details: Record<string, string> = {}
    const email = normalizeEmail(input.email ?? '')
    if (!EMAIL.test(email)) details.email = 'must be a valid email address'
    const shipTo = cleanAddress(input.shippingAddress) ?? {}
    if (!shipTo.name) details['shipping_address.name'] = 'is required'
    if (!shipTo.line1) details['shipping_address.line1'] = 'is required'
    if (!shipTo.city) details['shipping_address.city'] = 'is required'
    if (!shipTo.country || shipTo.country.length !== 2) details['shipping_address.country'] = 'is required'
    else shipTo.country = shipTo.country.toUpperCase()
    if (this.ctx.config.checkout.collectPhone && !input.phone?.trim()) details.phone = 'is required'
    let quote: Quote | null = null
    try {
      quote = await this.quote(input.items, shipTo.country ?? '', input.shippingOptionId, input.discountCode)
    } catch (error) {
      if (error instanceof Error && 'details' in error) Object.assign(details, (error as { details: Record<string, string> | null }).details ?? {})
      else throw error
    }
    if (Object.keys(details).length || !quote) throw invalid('Checkout is incomplete', details)

    const db = this.ctx.db
    const now = this.ctx.now()
    const orderId = newId('ord')
    const name = input.name?.trim() || shipTo.name || null
    const phone = input.phone?.trim() || null
    const metadata = Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([, v]) => typeof v === 'string').slice(0, 20))
    const statements: DbStatement[] = [
      db
        .prepare(
          `INSERT INTO customers (id, email, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, customers.name), phone = COALESCE(excluded.phone, customers.phone), updated_at = excluded.updated_at`
        )
        .bind(newId('cus'), email, name, phone, now, now),
      db
        .prepare(
          `INSERT INTO orders (id, number, status, payment_status, currency, subtotal, shipping, tax, discount, total, customer_id, email,
             shipping_address_json, billing_address_json, shipping_method_code, shipping_method_name, notes, metadata_json, access_key, created_at, updated_at,
             discount_code, discount_partner, partner_commission)
           VALUES (?, (SELECT COALESCE(MAX(number), 1000) + 1 FROM orders), 'pending_payment', 'unpaid', ?, ?, ?, 0, ?, ?, (SELECT id FROM customers WHERE email = ?), ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          orderId,
          quote.currency,
          quote.subtotal,
          quote.shipping,
          quote.discount,
          quote.total,
          email,
          email,
          JSON.stringify(shipTo),
          input.billingAddress ? JSON.stringify(cleanAddress(input.billingAddress)) : null,
          quote.option.id,
          quote.option.label,
          input.notes?.trim().slice(0, 2000) || null,
          JSON.stringify(metadata),
          randomToken(16),
          now,
          now,
          quote.discountCode ? normalizeDiscountCode(quote.discountCode.code) : null,
          quote.discountCode?.partner ?? null,
          quote.commission
        ),
      ...quote.lines.map((l, i) =>
        db
          .prepare(`INSERT INTO order_lines (id, order_id, sku, name, quantity, unit_amount, total_amount, fulfilled_quantity, image_url, position) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
          .bind(newId('lin'), orderId, l.sku, l.name, l.quantity, l.unitAmount, l.totalAmount, l.image, i)
      ),
      this.events.statement(orderId, 'created', {
        lines: quote.lines.length,
        total: quote.total,
        ...(quote.discountCode ? { discount_code: normalizeDiscountCode(quote.discountCode.code) } : {}),
        ...(quote.quantityTier ? { quantity_tier: quote.quantityTier.minQuantity } : {}),
        ...(quote.discount ? { discount: quote.discount } : {}),
      }),
    ]
    await db.batch(statements)
    return this.orders.require(orderId)
  }
}

function clampQuantity(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1
}
