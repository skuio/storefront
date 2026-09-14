import type { Category, CategoryNode, Product } from './types'

/**
 * An in-memory snapshot of the catalogue with the tree and the lookups the
 * pages need. Built from plain data — the store service builds one from the
 * database per request (cached briefly per isolate); tests build one from
 * fixtures.
 */
export class Catalog {
  readonly products: Product[]
  readonly categories: Category[]
  private readonly bySku = new Map<string, Product>()
  private readonly bySlug = new Map<string, Product>()
  private readonly categoryById = new Map<string, Category>()
  private readonly nodeById = new Map<string, CategoryNode>()
  private readonly roots: CategoryNode[]

  private constructor(products: Product[], categories: Category[]) {
    this.products = products
    this.categories = categories
    for (const p of products) {
      if (this.bySku.has(p.sku)) throw new Error(`Duplicate product sku: ${p.sku}`)
      this.bySku.set(p.sku, p)
      this.bySlug.set(p.slug, p)
    }
    for (const c of categories) this.categoryById.set(c.id, c)
    this.roots = this.buildTree()
  }

  static fromData(products: Product[], categories: Category[]): Catalog {
    return new Catalog(products, categories)
  }

  product(sku: string): Product | undefined {
    return this.bySku.get(sku)
  }

  productBySlug(slug: string): Product | undefined {
    return this.bySlug.get(slug)
  }

  /** Products directly in a category, or in it and every descendant with `deep`. */
  productsIn(categoryId: string, opts: { deep?: boolean } = {}): Product[] {
    const ids = new Set<string>([categoryId])
    if (opts.deep) {
      const node = this.nodeById.get(categoryId)
      if (node) this.collectIds(node, ids)
    }
    return this.products.filter((p) => p.categoryIds.some((id) => ids.has(id)))
  }

  tree(): CategoryNode[] {
    return this.roots
  }

  category(id: string): CategoryNode | undefined {
    return this.nodeById.get(id)
  }

  /** Find a node by its slug path from the root, e.g. ['toyota', 'tacoma']. */
  categoryByPath(path: string[]): CategoryNode | undefined {
    let level = this.roots
    let found: CategoryNode | undefined
    for (const slug of path) {
      found = level.find((n) => n.slug === slug)
      if (!found) return undefined
      level = found.children
    }
    return found
  }

  allCategories(): CategoryNode[] {
    return [...this.nodeById.values()]
  }

  /** The chain of categories from the root to the product's deepest category. */
  breadcrumbs(product: Product): CategoryNode[] {
    let best: CategoryNode | undefined
    for (const id of product.categoryIds) {
      const node = this.nodeById.get(id)
      if (node && (!best || node.depth > best.depth)) best = node
    }
    if (!best) return []
    const chain: CategoryNode[] = []
    let cur: CategoryNode | undefined = best
    while (cur) {
      chain.unshift(cur)
      cur = cur.parentId ? this.nodeById.get(cur.parentId) : undefined
    }
    return chain
  }

  /** Every node with at least one product in it or below it. */
  nonEmptyCategories(): CategoryNode[] {
    return this.allCategories().filter((n) => n.productCount > 0)
  }

  private collectIds(node: CategoryNode, into: Set<string>): void {
    for (const child of node.children) {
      into.add(child.id)
      this.collectIds(child, into)
    }
  }

  private buildTree(): CategoryNode[] {
    const nodes = new Map<string, CategoryNode>()
    for (const c of this.categories) {
      nodes.set(c.id, { ...c, children: [], path: [], depth: 0, productCount: 0 })
    }
    const roots: CategoryNode[] = []
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    const byName = (a: CategoryNode, b: CategoryNode) =>
      (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name)
    const walk = (node: CategoryNode, path: string[], depth: number): Set<string> => {
      node.path = [...path, node.slug]
      node.depth = depth
      node.children.sort(byName)
      const skus = new Set<string>()
      for (const p of this.products) if (p.categoryIds.includes(node.id)) skus.add(p.sku)
      for (const child of node.children) for (const sku of walk(child, node.path, depth + 1)) skus.add(sku)
      node.productCount = skus.size
      this.nodeById.set(node.id, node)
      return skus
    }
    roots.sort(byName)
    for (const root of roots) walk(root, [], 0)
    return roots
  }
}
