#!/usr/bin/env node
/**
 * Migrate a WooCommerce catalog into this store.
 *
 *   node scripts/export-woocommerce.mjs --origin https://www.example.com [--out src/data]
 *
 * Reads only WooCommerce's public Store API — no credentials, safe to re-run
 * while the old site is still up. Writes:
 *   src/data/products.json       @skuio/storefront Product[]
 *   src/data/categories.json     @skuio/storefront Category[]
 *   src/data/image-sources.json  basename -> original URL, for fetch-images.mjs
 *
 * The primary category (categoryIds[0]) is the one whose slug chain appears in
 * the product's permalink when WooCommerce puts categories in product URLs;
 * otherwise the first assigned category. legacyPath is kept on every product
 * so the store can preserve or redirect old URLs.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const ORIGIN = arg('origin')
if (!ORIGIN) {
  console.error('usage: node scripts/export-woocommerce.mjs --origin https://www.example.com [--out src/data]')
  process.exit(1)
}
const STORE = `${ORIGIN.replace(/\/$/, '')}/wp-json/wc/store/v1`
const OUT = resolve(process.cwd(), arg('out', 'src/data'))

const decodeEntities = (s) =>
  !s ? s : s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')

const imageBasename = (url) =>
  decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/[^a-zA-Z0-9._-]/g, '_')

async function getAll(path) {
  const out = []
  for (let page = 1; ; page++) {
    const res = await fetch(`${STORE}/${path}?per_page=100&page=${page}`)
    if (!res.ok) throw new Error(`${STORE}/${path} -> ${res.status}`)
    const batch = await res.json()
    out.push(...batch)
    if (page >= Number(res.headers.get('x-wp-totalpages') || 1) || batch.length === 0) break
  }
  return out
}

const [rawProducts, rawCategories] = await Promise.all([getAll('products'), getAll('products/categories')])

const byId = new Map(rawCategories.map((c) => [c.id, c]))
const slugPath = (id) => {
  const out = []
  let c = byId.get(id)
  while (c) {
    out.unshift(c.slug)
    c = c.parent ? byId.get(c.parent) : null
  }
  return out
}

const variable = rawProducts.filter((p) => p.type !== 'simple')
if (variable.length) {
  console.warn(`WARNING: ${variable.length} product(s) are not "simple" (${[...new Set(variable.map((p) => p.type))].join(', ')}). ` +
    'The kit has no variants yet; they are exported as-is and their options are dropped.')
}

const imageSources = {}
const products = rawProducts.map((p) => {
  const price = Number(p.prices.price)
  const regular = Number(p.prices.regular_price)
  const currency = p.prices.currency_code.toLowerCase()
  const permalinkSegs = new URL(p.permalink).pathname.split('/').filter(Boolean)
  const assigned = p.categories.map((c) => c.id)
  // If the permalink embeds a category chain, prefer the assigned category that reproduces it.
  const primary = assigned.find((id) => {
    const chain = slugPath(id)
    return chain.length && chain.every((s) => permalinkSegs.includes(s))
  }) ?? assigned[0]
  const categoryIds = primary === undefined ? [] : [primary, ...assigned.filter((id) => id !== primary)].map(String)

  for (const i of p.images) imageSources[imageBasename(i.src)] = i.src

  return {
    id: String(p.id),
    sku: decodeEntities(p.sku) || `WC-${p.id}`,
    name: decodeEntities(p.name),
    slug: p.slug,
    ...(p.short_description ? { shortDescription: p.short_description } : {}),
    ...(p.description ? { description: p.description } : {}),
    price: { amount: price, currency },
    ...(p.on_sale && regular > price ? { compareAtPrice: { amount: regular, currency } } : {}),
    categoryIds,
    images: p.images.map((i) => ({ src: imageBasename(i.src), ...(i.alt ? { alt: decodeEntities(i.alt) } : {}) })),
    available: Boolean(p.is_purchasable && p.is_in_stock),
    legacyPath: new URL(p.permalink).pathname,
  }
})

const categories = rawCategories.map((c) => ({
  id: String(c.id),
  name: decodeEntities(c.name),
  slug: c.slug,
  parentId: c.parent ? String(c.parent) : null,
  ...(c.description ? { description: decodeEntities(c.description) } : {}),
  ...(c.image?.src ? { image: c.image.src } : {}),
}))

products.sort((a, b) => a.sku.localeCompare(b.sku))
categories.sort((a, b) => a.name.localeCompare(b.name))

await mkdir(OUT, { recursive: true })
await writeFile(`${OUT}/products.json`, JSON.stringify(products, null, 2) + '\n')
await writeFile(`${OUT}/categories.json`, JSON.stringify(categories, null, 2) + '\n')
await writeFile(`${OUT}/image-sources.json`, JSON.stringify(imageSources, null, 2) + '\n')

const noCat = products.filter((p) => p.categoryIds.length === 0).length
console.log(`products ${products.length} · categories ${categories.length} · images ${Object.keys(imageSources).length} · written to ${OUT}`)
if (noCat) console.warn(`WARNING: ${noCat} product(s) have no category; they will not appear on any collection page.`)
