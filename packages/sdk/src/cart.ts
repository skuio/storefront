import type { Money } from './types.js'
import { addMoney, multiplyMoney } from './money.js'

/**
 * A cart is client-side state — lines the customer has chosen, with a snapshot
 * of what they saw (name, price) so the cart page can render without the
 * catalog. It is never trusted for money: checkout re-prices every SKU on the
 * server. These are pure functions; the browser store wraps them.
 */
export interface CartLine {
  sku: string
  quantity: number
  name: string
  unitPrice: Money
  url?: string
  image?: string
}

export interface Cart {
  lines: CartLine[]
  updatedAt: string
}

export const MAX_CART_LINES = 50

export const emptyCart = (): Cart => ({ lines: [], updatedAt: new Date().toISOString() })

function touch(lines: CartLine[]): Cart {
  return { lines, updatedAt: new Date().toISOString() }
}

export function addLine(cart: Cart, line: Omit<CartLine, 'quantity'>, quantity: number, maxQuantity: number): Cart {
  const qty = clampQty(quantity, maxQuantity)
  const existing = cart.lines.find((l) => l.sku === line.sku)
  if (existing) {
    return touch(
      cart.lines.map((l) => (l.sku === line.sku ? { ...l, ...line, quantity: clampQty(l.quantity + qty, maxQuantity) } : l))
    )
  }
  if (cart.lines.length >= MAX_CART_LINES) throw new Error(`Cart is limited to ${MAX_CART_LINES} lines`)
  return touch([...cart.lines, { ...line, quantity: qty }])
}

export function setQuantity(cart: Cart, sku: string, quantity: number, maxQuantity: number): Cart {
  if (quantity <= 0) return removeLine(cart, sku)
  return touch(cart.lines.map((l) => (l.sku === sku ? { ...l, quantity: clampQty(quantity, maxQuantity) } : l)))
}

export function removeLine(cart: Cart, sku: string): Cart {
  return touch(cart.lines.filter((l) => l.sku !== sku))
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.quantity, 0)
}

/** Snapshot subtotal for display only. The server computes the real one. */
export function cartSubtotal(cart: Cart, currency: string): Money {
  return cart.lines.reduce((sum, l) => addMoney(sum, multiplyMoney(l.unitPrice, l.quantity)), { amount: 0, currency })
}

/** What the checkout endpoint needs — nothing but SKUs and quantities. */
export function cartToCheckoutItems(cart: Cart): { sku: string; quantity: number }[] {
  return cart.lines.map((l) => ({ sku: l.sku, quantity: l.quantity }))
}

/**
 * Parse stored JSON defensively: anything malformed yields an empty cart
 * rather than a broken page. Money amounts must be integers.
 */
export function parseCart(raw: string | null | undefined): Cart {
  if (!raw) return emptyCart()
  try {
    const data = JSON.parse(raw) as Partial<Cart>
    if (!Array.isArray(data.lines)) return emptyCart()
    const lines: CartLine[] = []
    for (const l of data.lines as Partial<CartLine>[]) {
      if (
        typeof l?.sku !== 'string' || !l.sku ||
        typeof l.name !== 'string' ||
        !Number.isInteger(l.quantity) || (l.quantity as number) < 1 ||
        !l.unitPrice || !Number.isInteger(l.unitPrice.amount) || typeof l.unitPrice.currency !== 'string'
      ) continue
      lines.push({
        sku: l.sku, name: l.name, quantity: l.quantity as number,
        unitPrice: { amount: l.unitPrice.amount, currency: l.unitPrice.currency },
        ...(typeof l.url === 'string' ? { url: l.url } : {}),
        ...(typeof l.image === 'string' ? { image: l.image } : {}),
      })
    }
    return { lines: lines.slice(0, MAX_CART_LINES), updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString() }
  } catch {
    return emptyCart()
  }
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify(cart)
}

function clampQty(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1
}
