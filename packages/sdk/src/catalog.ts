import type { CatalogProvider } from './provider.js'
import type { Category, CategoryNode, Product } from './types.js'

/**
 * In-memory query layer over a provider's data.
 *
 * Loaded once per build (or per request in dynamic contexts) and then queried
 * synchronously, which is what a prerendering framework needs: `getStaticPaths`
 * cannot await per-page.
 */
export class Catalog {
  private readonly bySku = new Map<string, Product>()
  private readonly bySlug = new Map<string, Product>()
  private readonly byCategoryId = new Map<string, Product[]>()
  private readonly nodeById = new Map<string, CategoryNode>()
  private readonly nodeByPath = new Map<string, CategoryNode>()
  private readonly roots: CategoryNode[]

  private constructor(
    readonly products: Product[],
    readonly categories: Category[]
  ) {
    for (const p of products) {
      this.bySku.set(p.sku, p)
      this.bySlug.set(p.slug, p)
      for (const id of p.categoryIds) {
        const list = this.byCategoryId.get(id) ?? []
        list.push(p)
        this.byCategoryId.set(id, list)
      }
    }
    this.roots = this.buildTree()
  }

  static async load(provider: CatalogProvider): Promise<Catalog> {
    const [products, categories] = await Promise.all([provider.products(), provider.categories()])
    return new Catalog(products, categories)
  }

  static fromData(products: Product[], categories: Category[]): Catalog {
    return new Catalog(products, categories)
  }

  // -- products -----------------------------------------------------------

  product(sku: string): Product | undefined {
    return this.bySku.get(sku)
  }

  productBySlug(slug: string): Product | undefined {
    return this.bySlug.get(slug)
  }

  /** Products directly in a category, or in it and every descendant with `deep`. */
  productsIn(categoryId: string, opts: { deep?: boolean } = {}): Product[] {
    if (!opts.deep) return [...(this.byCategoryId.get(categoryId) ?? [])]
    const node = this.nodeById.get(categoryId)
    if (!node) return []
    const seen = new Set<string>()
    const out: Product[] = []
    const walk = (n: CategoryNode) => {
      for (const p of this.byCategoryId.get(n.id) ?? []) {
        if (!seen.has(p.id)) {
          seen.add(p.id)
          out.push(p)
        }
      }
      n.children.forEach(walk)
    }
    walk(node)
    return out
  }

  // -- categories ---------------------------------------------------------

  /** Top-level categories, with the full tree beneath them. */
  tree(): CategoryNode[] {
    return this.roots
  }

  category(id: string): CategoryNode | undefined {
    return this.nodeById.get(id)
  }

  /** Look a node up by its slug path, e.g. ['toyota', 'tacoma-95-04']. */
  categoryByPath(path: string[]): CategoryNode | undefined {
    return this.nodeByPath.get(path.join('/'))
  }

  /** Every node in the tree, depth-first. Useful for getStaticPaths. */
  allCategories(): CategoryNode[] {
    const out: CategoryNode[] = []
    const walk = (n: CategoryNode) => {
      out.push(n)
      n.children.forEach(walk)
    }
    this.roots.forEach(walk)
    return out
  }

  /** The primary category chain for a product, root first. */
  breadcrumbs(product: Product): CategoryNode[] {
    const primary = product.categoryIds[0]
    if (!primary) return []
    const leaf = this.nodeById.get(primary)
    if (!leaf) return []
    const chain: CategoryNode[] = []
    let cur: CategoryNode | undefined = leaf
    while (cur) {
      chain.unshift(cur)
      cur = cur.parentId ? this.nodeById.get(cur.parentId) : undefined
    }
    return chain
  }

  /** Nodes with no products anywhere beneath them are usually not worth a page. */
  nonEmptyCategories(): CategoryNode[] {
    return this.allCategories().filter((n) => n.productCount > 0)
  }

  // -- internals ----------------------------------------------------------

  private buildTree(): CategoryNode[] {
    const nodes = new Map<string, CategoryNode>()
    for (const c of this.categories) {
      nodes.set(c.id, { ...c, children: [], path: [], depth: 0, productCount: 0 })
    }

    const roots: CategoryNode[] = []
    for (const n of nodes.values()) {
      const parent = n.parentId ? nodes.get(n.parentId) : undefined
      if (parent) parent.children.push(n)
      else roots.push(n)
    }

    const byName = (a: CategoryNode, b: CategoryNode) => a.name.localeCompare(b.name)
    const finish = (n: CategoryNode, parentPath: string[], depth: number): number => {
      n.path = [...parentPath, n.slug]
      n.depth = depth
      n.children.sort(byName)
      let count = (this.byCategoryId.get(n.id) ?? []).length
      for (const child of n.children) count += finish(child, n.path, depth + 1)
      n.productCount = count
      this.nodeById.set(n.id, n)
      this.nodeByPath.set(n.path.join('/'), n)
      return count
    }
    roots.sort(byName)
    for (const r of roots) finish(r, [], 0)
    return roots
  }
}
