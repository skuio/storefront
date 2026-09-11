import type { CatalogProvider } from '../provider.js'
import type { Category, Product } from '../types.js'

type Loader<T> = T[] | (() => T[] | Promise<T[]>)

export interface JsonProviderOptions {
  products: Loader<Product>
  categories: Loader<Category>
}

/**
 * Catalogue from committed JSON.
 *
 * Accepts arrays directly (the framework `import`s the files) or a loader
 * function for lazy reads. No network, no credentials: a store on this provider
 * is fully static and runs anywhere.
 */
export function jsonProvider(opts: JsonProviderOptions): CatalogProvider {
  const resolve = async <T>(l: Loader<T>): Promise<T[]> => (typeof l === 'function' ? l() : l)

  return {
    name: 'json',
    async products() {
      const items = await resolve(opts.products)
      assertUnique(items.map((p) => p.sku), 'sku')
      assertUnique(items.map((p) => p.slug), 'slug')
      return items
    },
    categories() {
      return resolve(opts.categories)
    },
  }
}

function assertUnique(values: string[], field: string) {
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) throw new Error(`Duplicate product ${field}: "${v}"`)
    seen.add(v)
  }
}
