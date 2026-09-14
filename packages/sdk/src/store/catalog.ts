import { Catalog } from '../catalog'
import type { Database, DbStatement } from '../db/driver'
import { slugify } from '../slug'
import type { Availability, Category, Money, Product, ProductImage } from '../types'
import { chunk, parseJson, placeholders, type StoreContext } from './context'
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor'
import { invalid, notFound } from './errors'

/** Product payload as the Store API and the seed script send it. */
export interface ProductInput {
  sku: string
  name: string
  slug?: string | null
  description_html?: string | null
  short_description_html?: string | null
  price: Money
  compare_at_price?: Money | null
  images?: { url: string; alt?: string | null }[]
  category_ids?: string[]
  attributes?: Record<string, string>
  active?: boolean
  position?: number
  /** Not part of the Store API; a migrated store's seed sets it. */
  legacy_path?: string | null
}

export interface CategoryInput {
  id: string
  name: string
  slug?: string | null
  parent_id?: string | null
  description_html?: string | null
  image?: { url: string; alt?: string | null } | null
  position?: number
}

interface ProductRow {
  sku: string
  name: string
  slug: string
  description_html: string | null
  short_description_html: string | null
  price_amount: number
  currency: string
  compare_at_amount: number | null
  attributes_json: string
  active: number
  position: number
  legacy_path: string | null
  created_at: string
  updated_at: string
}

interface CategoryRow {
  id: string
  name: string
  slug: string
  parent_id: string | null
  description_html: string | null
  image_url: string | null
  image_alt: string | null
  position: number
  created_at: string
  updated_at: string
}

/** One product as the Store API reads it back — the whole row, not the shopper-facing projection. */
export interface ProductRecord {
  sku: string
  name: string
  slug: string
  descriptionHtml: string | null
  shortDescriptionHtml: string | null
  price: Money
  compareAtPrice: Money | null
  attributes: Record<string, string>
  active: boolean
  position: number
  legacyPath: string | null
  /** In the product's own order. `slug`/`name` are null for a link to a category the store never received. */
  categories: { id: string; slug: string | null; name: string | null }[]
  images: { url: string; alt: string | null; position: number }[]
  inventory: { available: number; allowBackorder: boolean; updatedAt: string } | null
  createdAt: string
  updatedAt: string
}

export interface CategoryRecord {
  id: string
  parentId: string | null
  slug: string
  name: string
  descriptionHtml: string | null
  position: number
  productCount: number
  createdAt: string
  updatedAt: string
}

export interface ProductPage {
  products: ProductRecord[]
  nextCursor: string | null
}

export interface CategoryPage {
  categories: CategoryRecord[]
  nextCursor: string | null
}

export interface ProductListQuery {
  updatedSince?: string | null
  cursor?: string | null
  limit?: number
  /** Omit for every product; true/false to filter on the storefront flag. */
  active?: boolean | null
}

export interface CategoryListQuery {
  cursor?: string | null
  limit?: number
}

interface InventoryRow {
  sku: string
  available: number
  allow_backorder: number
  updated_at: string
}

interface CacheEntry {
  expires: number
  catalog: Promise<Catalog>
}

// One snapshot per database binding per isolate, refreshed on a short TTL and
// dropped by every write this isolate makes.
const cache = new WeakMap<Database, CacheEntry>()

export function deriveAvailability(inv: { available: number; allow_backorder: number; updated_at?: string } | undefined, lowStockThreshold: number): Availability | undefined {
  if (!inv) return undefined
  const status =
    inv.available <= 0 ? (inv.allow_backorder ? 'backorder' : 'out_of_stock') : inv.available <= lowStockThreshold ? 'low_stock' : 'in_stock'
  return { status, quantity: inv.available, ...(inv.updated_at ? { updatedAt: inv.updated_at } : {}) }
}

export class CatalogService {
  constructor(private readonly ctx: StoreContext, private readonly ttlMs: number) {}

  /** The catalogue snapshot: active products with availability, and the category tree. */
  load(): Promise<Catalog> {
    const hit = cache.get(this.ctx.db)
    if (hit && hit.expires > Date.now()) return hit.catalog
    const catalog = this.build()
    if (this.ttlMs > 0) cache.set(this.ctx.db, { expires: Date.now() + this.ttlMs, catalog })
    catalog.catch(() => cache.delete(this.ctx.db))
    return catalog
  }

  invalidate(): void {
    cache.delete(this.ctx.db)
  }

  private async build(): Promise<Catalog> {
    const db = this.ctx.db
    const [products, categories, links, images, inventory] = await Promise.all([
      db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY position, name`).all<ProductRow>(),
      db.prepare(`SELECT * FROM categories ORDER BY position, name`).all<CategoryRow>(),
      db.prepare(`SELECT pc.sku, pc.category_id FROM product_categories pc JOIN products p ON p.sku = pc.sku WHERE p.active = 1 ORDER BY pc.position`).all<{ sku: string; category_id: string }>(),
      db.prepare(`SELECT pi.sku, pi.url, pi.alt FROM product_images pi JOIN products p ON p.sku = pi.sku WHERE p.active = 1 ORDER BY pi.position, pi.id`).all<{ sku: string; url: string; alt: string | null }>(),
      db.prepare(`SELECT * FROM inventory`).all<InventoryRow>(),
    ])
    const categoryIds = new Map<string, string[]>()
    for (const l of links.results) (categoryIds.get(l.sku) ?? categoryIds.set(l.sku, []).get(l.sku)!).push(l.category_id)
    const imagesBySku = new Map<string, ProductImage[]>()
    for (const i of images.results) (imagesBySku.get(i.sku) ?? imagesBySku.set(i.sku, []).get(i.sku)!).push({ src: i.url, ...(i.alt ? { alt: i.alt } : {}) })
    const inv = new Map(inventory.results.map((r) => [r.sku, r]))
    const threshold = this.ctx.config.inventory.lowStockThreshold

    const list: Product[] = products.results.map((r) => {
      const availability = deriveAvailability(inv.get(r.sku), threshold)
      return {
        id: r.sku,
        sku: r.sku,
        name: r.name,
        slug: r.slug,
        ...(r.description_html ? { description: r.description_html } : {}),
        ...(r.short_description_html ? { shortDescription: r.short_description_html } : {}),
        price: { amount: r.price_amount, currency: r.currency },
        ...(r.compare_at_amount != null ? { compareAtPrice: { amount: r.compare_at_amount, currency: r.currency } } : {}),
        categoryIds: categoryIds.get(r.sku) ?? [],
        images: imagesBySku.get(r.sku) ?? [],
        available: !availability || availability.status !== 'out_of_stock',
        ...(availability ? { availability } : {}),
        attributes: parseJson<Record<string, string>>(r.attributes_json, {}),
        position: r.position,
        ...(r.legacy_path ? { legacyPath: r.legacy_path } : {}),
      }
    })
    const cats: Category[] = categories.results.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      parentId: r.parent_id,
      ...(r.description_html ? { description: r.description_html } : {}),
      ...(r.image_url ? { image: { src: r.image_url, ...(r.image_alt ? { alt: r.image_alt } : {}) } } : {}),
      position: r.position,
    }))
    return Catalog.fromData(list, cats)
  }

  async counts(): Promise<{ products: number; categories: number }> {
    const [p, c] = await Promise.all([
      this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1`).first<{ n: number }>(),
      this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM categories`).first<{ n: number }>(),
    ])
    return { products: p?.n ?? 0, categories: c?.n ?? 0 }
  }

  /** Every product row including inactive ones — the Store API's view for `unknown_skus` checks. */
  async existingSkus(skus: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (const part of chunk([...new Set(skus)])) {
      const { results } = await this.ctx.db
        .prepare(`SELECT sku FROM products WHERE sku IN (${placeholders(part.length)})`)
        .bind(...part)
        .all<{ sku: string }>()
      for (const r of results) found.add(r.sku)
    }
    return found
  }

  /**
   * Products in keyset order, for an operations system importing the catalogue.
   * Ordered by `(updated_at, sku)` so a cursor is strictly monotonic and a
   * re-run from a watermark never repeats or skips a row.
   */
  async listProducts(query: ProductListQuery = {}): Promise<ProductPage> {
    const size = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), 200)
    const where: string[] = []
    const args: (string | number)[] = []
    if (query.cursor) {
      const parts = decodeKeysetCursor(query.cursor, 2)
      if (!parts) throw invalid('Invalid cursor', { cursor: 'is not a cursor this store issued' })
      where.push(`(updated_at, sku) > (?, ?)`)
      args.push(String(parts[0]), String(parts[1]))
    } else if (query.updatedSince) {
      where.push(`updated_at >= ?`)
      args.push(query.updatedSince)
    }
    if (query.active != null) {
      where.push(`active = ?`)
      args.push(query.active ? 1 : 0)
    }
    const sql = `SELECT * FROM products${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at ASC, sku ASC LIMIT ?`
    const { results } = await this.ctx.db.prepare(sql).bind(...args, size + 1).all<ProductRow>()
    const rows = results.slice(0, size)
    const last = rows[rows.length - 1]
    return {
      products: await this.hydrateProducts(rows),
      nextCursor: results.length > size && last ? encodeKeysetCursor([last.updated_at, last.sku]) : null,
    }
  }

  /** One product by SKU, active or not. Throws `not_found` when the store has never held it. */
  async requireProduct(sku: string): Promise<ProductRecord> {
    const row = await this.ctx.db.prepare(`SELECT * FROM products WHERE sku = ?`).bind(sku).first<ProductRow>()
    if (!row) throw notFound('Product')
    const [product] = await this.hydrateProducts([row])
    return product!
  }

  /**
   * The category tree as a flat list, parents before children within a branch.
   * `COALESCE(parent_id, '')` keeps every sort key non-null so the keyset
   * comparison can never drop a root category.
   */
  async listCategories(query: CategoryListQuery = {}): Promise<CategoryPage> {
    const size = Math.min(Math.max(Math.trunc(query.limit ?? 500) || 500, 1), 1000)
    const where: string[] = []
    const args: (string | number)[] = []
    if (query.cursor) {
      const parts = decodeKeysetCursor(query.cursor, 3)
      if (!parts) throw invalid('Invalid cursor', { cursor: 'is not a cursor this store issued' })
      where.push(`(COALESCE(c.parent_id, ''), c.position, c.id) > (?, ?, ?)`)
      args.push(String(parts[0]), Number(parts[1]), String(parts[2]))
    }
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = c.id) AS product_count
                 FROM categories c${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY COALESCE(c.parent_id, '') ASC, c.position ASC, c.id ASC LIMIT ?`
    const { results } = await this.ctx.db.prepare(sql).bind(...args, size + 1).all<CategoryRow & { product_count: number }>()
    const rows = results.slice(0, size)
    const last = rows[rows.length - 1]
    return {
      categories: rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        slug: r.slug,
        name: r.name,
        descriptionHtml: r.description_html,
        position: r.position,
        productCount: r.product_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      nextCursor: results.length > size && last ? encodeKeysetCursor([last.parent_id ?? '', last.position, last.id]) : null,
    }
  }

  /** Attach categories, images and stock to a page of product rows. */
  private async hydrateProducts(rows: ProductRow[]): Promise<ProductRecord[]> {
    if (rows.length === 0) return []
    const skus = rows.map((r) => r.sku)
    const links = new Map<string, { id: string; slug: string | null; name: string | null }[]>()
    const images = new Map<string, { url: string; alt: string | null; position: number }[]>()
    const inventory = new Map<string, InventoryRow>()
    for (const part of chunk(skus)) {
      const ph = placeholders(part.length)
      const [l, i, inv] = await Promise.all([
        // LEFT JOIN: a link to a category the store never received still reports its id.
        this.ctx.db
          .prepare(`SELECT pc.sku, pc.category_id, c.slug, c.name FROM product_categories pc LEFT JOIN categories c ON c.id = pc.category_id WHERE pc.sku IN (${ph}) ORDER BY pc.position, pc.category_id`)
          .bind(...part)
          .all<{ sku: string; category_id: string; slug: string | null; name: string | null }>(),
        this.ctx.db
          .prepare(`SELECT sku, url, alt, position FROM product_images WHERE sku IN (${ph}) ORDER BY position, id`)
          .bind(...part)
          .all<{ sku: string; url: string; alt: string | null; position: number }>(),
        this.ctx.db.prepare(`SELECT * FROM inventory WHERE sku IN (${ph})`).bind(...part).all<InventoryRow>(),
      ])
      for (const r of l.results) (links.get(r.sku) ?? links.set(r.sku, []).get(r.sku)!).push({ id: r.category_id, slug: r.slug, name: r.name })
      for (const r of i.results) (images.get(r.sku) ?? images.set(r.sku, []).get(r.sku)!).push({ url: r.url, alt: r.alt, position: r.position })
      for (const r of inv.results) inventory.set(r.sku, r)
    }
    return rows.map((r) => {
      const stock = inventory.get(r.sku)
      return {
        sku: r.sku,
        name: r.name,
        slug: r.slug,
        descriptionHtml: r.description_html,
        shortDescriptionHtml: r.short_description_html,
        price: { amount: r.price_amount, currency: r.currency },
        compareAtPrice: r.compare_at_amount != null ? { amount: r.compare_at_amount, currency: r.currency } : null,
        attributes: parseJson<Record<string, string>>(r.attributes_json, {}),
        active: r.active === 1,
        position: r.position,
        legacyPath: r.legacy_path,
        categories: links.get(r.sku) ?? [],
        images: images.get(r.sku) ?? [],
        inventory: stock ? { available: stock.available, allowBackorder: stock.allow_backorder === 1, updatedAt: stock.updated_at } : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    })
  }

  /**
   * Upsert products. Slugs: an explicit slug wins; an existing product keeps
   * its slug; a new one gets a slugified name, suffixed with the SKU when taken.
   */
  async upsertProducts(inputs: ProductInput[]): Promise<number> {
    if (inputs.length === 0) return 0
    const db = this.ctx.db
    const now = this.ctx.now()
    const skus = inputs.map((p) => p.sku)
    const existing = new Map<string, string>()
    for (const part of chunk(skus)) {
      const { results } = await db.prepare(`SELECT sku, slug FROM products WHERE sku IN (${placeholders(part.length)})`).bind(...part).all<{ sku: string; slug: string }>()
      for (const r of results) existing.set(r.sku, r.slug)
    }
    // Slug ownership across the whole table, so a new product never steals a URL.
    const wanted = inputs.map((p) => (p.slug?.trim() || existing.get(p.sku) || slugify(p.name)))
    const owners = new Map<string, string>()
    for (const part of chunk([...new Set(wanted)])) {
      const { results } = await db.prepare(`SELECT sku, slug FROM products WHERE slug IN (${placeholders(part.length)})`).bind(...part).all<{ sku: string; slug: string }>()
      for (const r of results) owners.set(r.slug, r.sku)
    }
    const taken = new Set<string>()
    const statements: DbStatement[] = []
    inputs.forEach((p, i) => {
      let slug = wanted[i]!
      const owner = owners.get(slug)
      if ((owner && owner !== p.sku) || taken.has(slug)) slug = `${slug}-${slugify(p.sku)}`
      taken.add(slug)
      if (p.price.currency.toLowerCase() !== this.ctx.config.currency.toLowerCase()) {
        throw invalid(`Product ${p.sku} is priced in ${p.price.currency}; this store sells in ${this.ctx.config.currency}`, { [`products.${i}.price.currency`]: 'must match the store currency' })
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO products (sku, name, slug, description_html, short_description_html, price_amount, currency, compare_at_amount, attributes_json, active, position, legacy_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (sku) DO UPDATE SET
               name = excluded.name, slug = excluded.slug, description_html = excluded.description_html,
               short_description_html = excluded.short_description_html, price_amount = excluded.price_amount,
               currency = excluded.currency, compare_at_amount = excluded.compare_at_amount, attributes_json = excluded.attributes_json,
               active = excluded.active, position = excluded.position,
               legacy_path = COALESCE(excluded.legacy_path, products.legacy_path), updated_at = excluded.updated_at`
          )
          .bind(
            p.sku,
            p.name,
            slug,
            p.description_html ?? null,
            p.short_description_html ?? null,
            p.price.amount,
            p.price.currency.toLowerCase(),
            p.compare_at_price?.amount ?? null,
            JSON.stringify(p.attributes ?? {}),
            p.active === false ? 0 : 1,
            p.position ?? i,
            p.legacy_path ?? null,
            now,
            now
          )
      )
      statements.push(db.prepare(`DELETE FROM product_categories WHERE sku = ?`).bind(p.sku))
      ;[...new Set(p.category_ids ?? [])].forEach((categoryId, pos) => {
        statements.push(db.prepare(`INSERT INTO product_categories (sku, category_id, position) VALUES (?, ?, ?)`).bind(p.sku, categoryId, pos))
      })
      statements.push(db.prepare(`DELETE FROM product_images WHERE sku = ?`).bind(p.sku))
      ;(p.images ?? []).forEach((img, pos) => {
        statements.push(db.prepare(`INSERT INTO product_images (sku, url, alt, position) VALUES (?, ?, ?, ?)`).bind(p.sku, img.url, img.alt ?? null, pos))
      })
    })
    for (const part of chunk(statements, 250)) await db.batch(part)
    this.invalidate()
    return inputs.length
  }

  /**
   * Upsert categories, migration-safe. A category is identified by its id;
   * when the id is unknown but a category with the same slug under the same
   * parent already exists, that row is ADOPTED (re-keyed to the incoming id,
   * with its products and children moved along) instead of a suffixed
   * duplicate being created. When the id is known and a same-parent row owns
   * the natural slug, that duplicate is merged into it. A slug owned by a
   * category under a different parent, or claimed twice in one batch, gets a
   * suffix. Parents in the batch are resolved first, so a whole tree pushed
   * with new ids over a seeded tree lands on the existing nodes.
   */
  async upsertCategories(inputs: CategoryInput[]): Promise<number> {
    if (inputs.length === 0) return 0
    const db = this.ctx.db
    const now = this.ctx.now()

    // The table is small; resolve everything against one snapshot kept in step with the statements.
    const { results } = await db.prepare(`SELECT id, slug, parent_id FROM categories`).all<{ id: string; slug: string; parent_id: string | null }>()
    const rows = new Map(results.map((r) => [r.id, { id: r.id, slug: r.slug, parentId: r.parent_id }]))
    const bySlug = new Map(results.map((r) => [r.slug, r.id]))
    const batchIds = new Set(inputs.map((c) => c.id))
    const statements: DbStatement[] = []

    const reparent = (from: string, to: string) => {
      for (const r of rows.values()) if (r.parentId === from) r.parentId = to
    }
    /** Move the products and children of `from` onto `to`. */
    const moveRefs = (from: string, to: string) => {
      statements.push(db.prepare(`UPDATE OR IGNORE product_categories SET category_id = ? WHERE category_id = ?`).bind(to, from))
      statements.push(db.prepare(`DELETE FROM product_categories WHERE category_id = ?`).bind(from))
      statements.push(db.prepare(`UPDATE categories SET parent_id = ? WHERE parent_id = ?`).bind(to, from))
      reparent(from, to)
    }
    /** Unknown incoming id: the existing same-parent row becomes the incoming id. */
    const adopt = (existingId: string, incomingId: string) => {
      const row = rows.get(existingId)!
      statements.push(db.prepare(`UPDATE categories SET id = ? WHERE id = ?`).bind(incomingId, existingId))
      moveRefs(existingId, incomingId)
      rows.delete(existingId)
      rows.set(incomingId, { ...row, id: incomingId })
      bySlug.set(row.slug, incomingId)
    }
    /** Known incoming id: the same-parent duplicate is absorbed into it and deleted. */
    const merge = (duplicateId: string, intoId: string) => {
      const dup = rows.get(duplicateId)!
      moveRefs(duplicateId, intoId)
      statements.push(db.prepare(`DELETE FROM categories WHERE id = ?`).bind(duplicateId))
      rows.delete(duplicateId)
      bySlug.delete(dup.slug)
    }
    const sameParent = (ownerId: string, parentId: string | null) => (rows.get(ownerId)?.parentId ?? null) === parentId
    const freeSuffixed = (natural: string, id: string) => {
      let candidate = `${natural}-${slugify(id)}`
      for (let n = 2; bySlug.has(candidate); n++) candidate = `${natural}-${slugify(id)}-${n}`
      return candidate
    }

    for (const c of orderParentsFirst(inputs)) {
      const parentId = c.parent_id ?? null
      const existing = rows.get(c.id)
      const explicit = c.slug?.trim() || null
      const natural = explicit ?? slugify(c.name)
      let slug: string
      if (existing && !explicit) {
        // Slugs stay stable once set — unless a same-parent duplicate owns the natural one, which is healed by merging.
        const owner = bySlug.get(natural)
        if (owner && owner !== c.id && sameParent(owner, parentId) && !batchIds.has(owner)) {
          merge(owner, c.id)
          bySlug.delete(existing.slug)
          slug = natural
        } else {
          slug = existing.slug
        }
      } else {
        const owner = bySlug.get(natural)
        if (!owner || owner === c.id) {
          slug = natural
        } else if (sameParent(owner, parentId) && !batchIds.has(owner)) {
          if (existing) {
            merge(owner, c.id)
            bySlug.delete(existing.slug)
          } else {
            adopt(owner, c.id)
          }
          slug = natural
        } else {
          slug = existing?.slug === natural ? natural : freeSuffixed(natural, c.id)
          if (existing) bySlug.delete(existing.slug)
        }
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO categories (id, name, slug, parent_id, description_html, image_url, image_alt, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               name = excluded.name, slug = excluded.slug, parent_id = excluded.parent_id, description_html = excluded.description_html,
               image_url = excluded.image_url, image_alt = excluded.image_alt, position = excluded.position, updated_at = excluded.updated_at`
          )
          .bind(c.id, c.name, slug, parentId, c.description_html ?? null, c.image?.url ?? null, c.image?.alt ?? null, c.position ?? inputs.indexOf(c), now, now)
      )
      rows.set(c.id, { id: c.id, slug, parentId })
      bySlug.set(slug, c.id)
    }
    for (const part of chunk(statements, 250)) await db.batch(part)
    this.invalidate()
    return inputs.length
  }

  /** Deactivate: the product disappears from the store but stays for order history. */
  async deactivateProduct(sku: string): Promise<boolean> {
    const result = await this.ctx.db.prepare(`UPDATE products SET active = 0, updated_at = ? WHERE sku = ?`).bind(this.ctx.now(), sku).run()
    this.invalidate()
    return (result.meta?.changes ?? 0) > 0
  }
}

/** Parents before children, so an adopted parent is keyed to its incoming id before its children look it up. */
function orderParentsFirst(inputs: CategoryInput[]): CategoryInput[] {
  const pending = new Map(inputs.map((c) => [c.id, c]))
  const done = new Set<string>()
  const out: CategoryInput[] = []
  let progressed = true
  while (pending.size && progressed) {
    progressed = false
    for (const [id, c] of pending) {
      const parent = c.parent_id ?? null
      if (parent === null || !pending.has(parent) || done.has(parent)) {
        out.push(c)
        done.add(id)
        pending.delete(id)
        progressed = true
      }
    }
  }
  // A cycle is an inconsistent payload; take the rest in the order given.
  out.push(...pending.values())
  return out
}
