import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/catalog.js'
import { defineRoutes } from '../src/routes.js'
import { categories, products } from './fixtures.js'

const catalog = Catalog.fromData(products, categories)
const tacoma = catalog.product('VDCTOYTAC9504')!

describe('routes', () => {
  it('uses conventional defaults', () => {
    const r = defineRoutes()
    expect(r.product(tacoma, catalog)).toBe('/products/toyota-tacoma-1995-2004/')
    expect(r.category(catalog.categoryByPath(['toyota', 'tacoma-95-04'])!)).toBe('/collections/toyota/tacoma-95-04/')
    expect(r.shop()).toBe('/shop/')
  })

  it('reproduces a legacy WooCommerce scheme from :path', () => {
    const r = defineRoutes({
      product: '/shop/:path/:slug/',
      category: '/product-category/:path/',
    })
    expect(r.product(tacoma, catalog)).toBe('/shop/toyota/tacoma-95-04/toyota-tacoma-1995-2004/')
    expect(r.category(catalog.category('toyota')!)).toBe('/product-category/toyota/')
  })

  it('fails loudly on an unknown token', () => {
    expect(() => defineRoutes({ product: '/p/:nope/' }).product(tacoma, catalog)).toThrow(/needs :nope/)
  })
})
