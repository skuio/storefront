/**
 * Browser-side quote list: the "add to quote" basket, kept apart from the cart so a buyer can price a volume order
 * without it ever touching checkout. Same pure functions as the cart (lines of SKU + quantity + a display
 * snapshot), its own localStorage key and a `quote-list:change` event.
 *
 * Client-only: import it from <script> tags, never from frontmatter.
 */
import { addLine, cartCount, emptyCart, parseCart, removeLine, serializeCart, setQuantity, type Cart, type CartLine } from '@skuio/storefront'

const KEY = 'skuio.quote.v1'
const EVENT = 'quote-list:change'

function read(): Cart {
  try {
    return parseCart(window.localStorage.getItem(KEY))
  } catch {
    return emptyCart()
  }
}

function write(list: Cart): Cart {
  try {
    window.localStorage.setItem(KEY, serializeCart(list))
  } catch {
    /* private mode / quota — the list just will not persist */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: list }))
  return list
}

export const quoteList = {
  get: read,
  add: (line: Omit<CartLine, 'quantity'>, quantity: number, maxQuantity: number) => write(addLine(read(), line, quantity, maxQuantity)),
  setQuantity: (sku: string, quantity: number, maxQuantity: number) => write(setQuantity(read(), sku, quantity, maxQuantity)),
  remove: (sku: string) => write(removeLine(read(), sku)),
  clear: () => write(emptyCart()),
  count: () => cartCount(read()),
  /** What the quote endpoint needs — SKUs and quantities. Prices are the merchant's to set. */
  items: () => read().lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  subscribe(fn: (list: Cart) => void): () => void {
    const onLocal = (e: Event) => fn((e as CustomEvent<Cart>).detail)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) fn(read()) }
    window.addEventListener(EVENT, onLocal)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener(EVENT, onLocal); window.removeEventListener('storage', onStorage) }
  },
}
