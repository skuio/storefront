import type { Category, Product } from './types.js'

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
}
