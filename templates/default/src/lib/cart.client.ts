/**
 * Browser-side cart store. Wraps the SDK's pure cart functions with
 * localStorage and a `cart:change` event so any component can react.
 *
 * Client-only by design (the `.client.ts` suffix is a convention, not magic):
 * import it from <script> tags, never from frontmatter.
 */
import {
  addLine, cartCount, cartSubtotal, emptyCart, parseCart, removeLine, serializeCart, setQuantity,
  type Cart, type CartLine,
} from '@skuio/storefront'

const KEY = 'skuio.cart.v1'
const EVENT = 'cart:change'

function read(): Cart {
  try {
    return parseCart(window.localStorage.getItem(KEY))
  } catch {
    return emptyCart()
  }
}

function write(cart: Cart): Cart {
  try {
    window.localStorage.setItem(KEY, serializeCart(cart))
  } catch {
    /* private mode / quota — the cart just will not persist */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: cart }))
  return cart
}

export const cartStore = {
  get: read,
  add: (line: Omit<CartLine, 'quantity'>, quantity: number, maxQuantity: number) => write(addLine(read(), line, quantity, maxQuantity)),
  setQuantity: (sku: string, quantity: number, maxQuantity: number) => write(setQuantity(read(), sku, quantity, maxQuantity)),
  remove: (sku: string) => write(removeLine(read(), sku)),
  clear: () => write(emptyCart()),
  count: () => cartCount(read()),
  subtotal: (currency: string) => cartSubtotal(read(), currency),
  /** Subscribe to changes, including ones made in another tab. */
  subscribe(fn: (cart: Cart) => void): () => void {
    const onLocal = (e: Event) => fn((e as CustomEvent<Cart>).detail)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) fn(read()) }
    window.addEventListener(EVENT, onLocal)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener(EVENT, onLocal); window.removeEventListener('storage', onStorage) }
  },
}
