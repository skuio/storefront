import type { Category, Checkout, CheckoutRequest, Customer, CustomerOrder, CustomerSession, Product } from './types.js'

/**
 * A source of catalogue data.
 *
 * The `json` provider reads committed files and needs no backend — a store
 * runs entirely static. The `skuio` provider reads the live SKU.io Storefront
 * API. Swapping one for the other is a config change; nothing rendering the
 * catalogue knows which it is talking to.
 */
export interface CatalogProvider {
  readonly name: string
  products(): Promise<Product[]>
  categories(): Promise<Category[]>
  /**
   * Present when the provider can create the hosted checkout itself. SKU.io
   * does: it prices the lines, applies the storefront's shipping, and creates
   * the session on the tenant's own processor — so the store holds no
   * processor key. A store on a provider without this uses Stripe directly.
   */
  createCheckout?(request: CheckoutRequest): Promise<Checkout>
  getCheckout?(id: string): Promise<Checkout>
  /**
   * Present when the provider can sign customers in and show their orders.
   * The store keeps the session token in an httpOnly cookie and passes it
   * back here; the browser never sees it.
   */
  customers?: CustomerProvider
}

export interface CustomerProvider {
  /** Email a single-use sign-in link. Resolves whether or not the email is known. */
  requestSession(email: string, returnUrl: string): Promise<void>
  /** Turn the link's token into a session. Rejects when expired, used, or unknown. */
  exchange(token: string): Promise<CustomerSession>
  me(sessionToken: string): Promise<Customer>
  orders(sessionToken: string): Promise<CustomerOrder[]>
  revoke(sessionToken: string): Promise<void>
}
