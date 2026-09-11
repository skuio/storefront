import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/catalog.js'
import { jsonProvider } from '../src/providers/json.js'
import { categories, products } from './fixtures.js'

describe('Catalog', () => {
  it('loads from a provider and indexes by sku and slug', async () => {
    const catalog = await Catalog.load(jsonProvider({ products, categories }))
    expect(catalog.product('VDCTOYTAC9504')?.name).toBe('Toyota Tacoma 1995-2004')
    expect(catalog.productBySlug('honda-civic-2006-2011')?.sku).toBe('VDCHCIV0611')
    expect(catalog.product('nope')).toBeUndefined()
  })

  it('builds a tree with paths, depth and deep product counts', () => {
    const catalog = Catalog.fromData(products, categories)
    const tree = catalog.tree()
    expect(tree.map((n) => n.slug)).toEqual(['empty', 'honda', 'toyota'])

    const toyota = catalog.category('toyota')!
    expect(toyota.depth).toBe(0)
    expect(toyota.path).toEqual(['toyota'])
    expect(toyota.productCount).toBe(2)
    expect(toyota.children.map((c) => c.slug)).toEqual(['supra-93-02', 'tacoma-95-04'])

    const tacoma = catalog.categoryByPath(['toyota', 'tacoma-95-04'])!
    expect(tacoma.depth).toBe(1)
    expect(tacoma.productCount).toBe(1)
  })

  it('counts a product assigned to both parent and child once', () => {
    // WooCommerce exports do this: the product sits in "Acura" and in "Acura > CL 96-99".
    const both = products.map((p) => (p.sku === 'VDCTOYTAC9504' ? { ...p, categoryIds: ['toyota-tacoma', 'toyota'] } : p))
    const catalog = Catalog.fromData(both, categories)
    expect(catalog.category('toyota')!.productCount).toBe(2)
    expect(catalog.productsIn('toyota', { deep: true })).toHaveLength(2)
  })

  it('distinguishes direct from deep membership', () => {
    const catalog = Catalog.fromData(products, categories)
    expect(catalog.productsIn('toyota')).toHaveLength(0)
    expect(catalog.productsIn('toyota', { deep: true })).toHaveLength(2)
  })

  it('walks breadcrumbs root-first from the primary category', () => {
    const catalog = Catalog.fromData(products, categories)
    const crumbs = catalog.breadcrumbs(catalog.product('VDCTOYTAC9504')!)
    expect(crumbs.map((c) => c.slug)).toEqual(['toyota', 'tacoma-95-04'])
  })

  it('excludes empty categories when asked', () => {
    const catalog = Catalog.fromData(products, categories)
    expect(catalog.allCategories().map((c) => c.id)).toContain('empty')
    expect(catalog.nonEmptyCategories().map((c) => c.id)).not.toContain('empty')
  })

  it('rejects duplicate skus at load', async () => {
    const dupes = [...products, { ...products[0]!, id: 'x', slug: 'other' }]
    await expect(Catalog.load(jsonProvider({ products: dupes, categories }))).rejects.toThrow(/Duplicate product sku/)
  })
})
