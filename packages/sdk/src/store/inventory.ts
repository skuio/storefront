import type { DbStatement } from '../db/driver'
import type { Availability } from '../types'
import { deriveAvailability } from './catalog'
import { chunk, placeholders, type StoreContext } from './context'

export interface InventoryItemInput {
  sku: string
  available: number
  allow_backorder?: boolean
}

export interface InventoryResult {
  updated: number
  unknown_skus: string[]
}

export class InventoryService {
  constructor(private readonly ctx: StoreContext, private readonly existingSkus: (skus: string[]) => Promise<Set<string>>, private readonly invalidate: () => void) {}

  /** Set absolute available quantities. Unknown SKUs are reported, not created. */
  async set(items: InventoryItemInput[]): Promise<InventoryResult> {
    if (items.length === 0) return { updated: 0, unknown_skus: [] }
    const known = await this.existingSkus(items.map((i) => i.sku))
    const now = this.ctx.now()
    const unknown: string[] = []
    const statements: DbStatement[] = []
    let updated = 0
    for (const item of items) {
      if (!known.has(item.sku)) {
        unknown.push(item.sku)
        continue
      }
      // Stock is part of the product resource GET /products returns, so a change to it is a change
      // to the product: bump products.updated_at (before the upsert, and only when the values
      // differ) so a consumer polling `updated_since` sees the new quantity without a full sweep.
      updated++
      const available = Math.trunc(item.available)
      const backorder = item.allow_backorder ? 1 : 0
      statements.push(
        this.ctx.db
          .prepare(
            `UPDATE products SET updated_at = ? WHERE sku = ?
             AND NOT EXISTS (SELECT 1 FROM inventory WHERE sku = ? AND available = ? AND allow_backorder = ?)`
          )
          .bind(now, item.sku, item.sku, available, backorder)
      )
      statements.push(
        this.ctx.db
          .prepare(
            `INSERT INTO inventory (sku, available, allow_backorder, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (sku) DO UPDATE SET available = excluded.available, allow_backorder = excluded.allow_backorder, updated_at = excluded.updated_at`
          )
          .bind(item.sku, available, backorder, now)
      )
    }
    for (const part of chunk(statements, 250)) await this.ctx.db.batch(part)
    if (statements.length) this.invalidate()
    return { updated, unknown_skus: [...new Set(unknown)] }
  }

  /** Availability for a set of SKUs; SKUs without a row are untracked (undefined). */
  async availability(skus: string[]): Promise<Map<string, Availability | undefined>> {
    const out = new Map<string, Availability | undefined>()
    for (const sku of skus) out.set(sku, undefined)
    for (const part of chunk([...new Set(skus)])) {
      const { results } = await this.ctx.db
        .prepare(`SELECT sku, available, allow_backorder, updated_at FROM inventory WHERE sku IN (${placeholders(part.length)})`)
        .bind(...part)
        .all<{ sku: string; available: number; allow_backorder: number; updated_at: string }>()
      for (const r of results) out.set(r.sku, deriveAvailability(r, this.ctx.config.inventory.lowStockThreshold))
    }
    return out
  }

  /** Statements that move tracked stock by `delta` per SKU (negative to consume). Untracked SKUs are untouched. */
  adjustStatements(lines: { sku: string; quantity: number }[], direction: 1 | -1): DbStatement[] {
    const now = this.ctx.now()
    // A tracked SKU's product is bumped too, for the same reason as in set().
    return lines.flatMap((l) => [
      this.ctx.db
        .prepare(`UPDATE products SET updated_at = ? WHERE sku = ? AND EXISTS (SELECT 1 FROM inventory WHERE sku = ?)`)
        .bind(now, l.sku, l.sku),
      this.ctx.db
        .prepare(`UPDATE inventory SET available = available + ?, updated_at = ? WHERE sku = ?`)
        .bind(direction * l.quantity, now, l.sku),
    ])
  }
}
