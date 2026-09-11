import type { CatalogProvider } from '../provider.js'

export interface SkuioProviderOptions {
  /** Tenant origin, e.g. https://acme.sku.io */
  tenant: string
  /**
   * A storefront-scoped token — read catalogue, read availability, create
   * checkout. Never an admin personal access token: those carry write scopes
   * no storefront should hold.
   */
  storefrontToken: string
  /** Which of the tenant's storefronts this site is. */
  storefrontId: string
}

/**
 * Live catalogue from the SKU.io Storefront API.
 *
 * Not yet available: the Storefront API and storefront token type are being
 * added to SKU.io. Until they ship, this provider throws on use so a
 * misconfigured site fails at build time, not silently with an empty catalogue.
 */
export function skuioProvider(opts: SkuioProviderOptions): CatalogProvider {
  void opts
  const notYet = () => {
    throw new Error(
      '@skuio/storefront: the skuio provider needs the SKU.io Storefront API, which has not shipped yet. ' +
        'Use jsonProvider() for now — the two are drop-in interchangeable.'
    )
  }
  return {
    name: 'skuio',
    products: notYet,
    categories: notYet,
  }
}
