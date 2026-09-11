import type { CategoryNode, Product } from './types.js'
import type { Catalog } from './catalog.js'

/**
 * URL patterns. Tokens:
 *   :slug   product slug
 *   :sku    product SKU
 *   :path   category slug path joined with '/', e.g. toyota/tacoma-95-04
 *
 * Defaults are conventional; a migrated store sets them to match its legacy
 * URLs so nothing indexed ever moves. Patterns should start and end with '/'.
 */
export interface RoutePatterns {
  product: string
  category: string
  /** Where the full catalogue lives. */
  shop: string
}

export const DEFAULT_ROUTES: RoutePatterns = {
  product: '/products/:slug/',
  category: '/collections/:path/',
  shop: '/shop/',
}

export interface Routes {
  product(product: Product, catalog: Catalog): string
  category(node: CategoryNode): string
  shop(): string
  patterns: RoutePatterns
}

export function defineRoutes(partial: Partial<RoutePatterns> = {}): Routes {
  const patterns: RoutePatterns = { ...DEFAULT_ROUTES, ...partial }

  const fill = (pattern: string, vars: Record<string, string>) =>
    pattern.replace(/:(\w+)/g, (_, key: string) => {
      const v = vars[key]
      if (v === undefined) throw new Error(`Route pattern "${pattern}" needs :${key}`)
      return v
    })

  return {
    patterns,
    product(product, catalog) {
      const crumbs = catalog.breadcrumbs(product)
      return fill(patterns.product, {
        slug: product.slug,
        sku: encodeURIComponent(product.sku),
        path: crumbs.map((c) => c.slug).join('/'),
      })
    },
    category(node) {
      return fill(patterns.category, { path: node.path.join('/') })
    },
    shop() {
      return patterns.shop
    },
  }
}
