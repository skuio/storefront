#!/usr/bin/env node
/**
 * Seed the store database from src/data/products.json + categories.json.
 *
 *   node scripts/seed-store.mjs --local     # the local D1 used by `astro dev`
 *   node scripts/seed-store.mjs --remote    # the production database
 *   node scripts/seed-store.mjs --sqlite    # the SQLite file of a Node-hosted store (DATABASE_PATH)
 *
 * Generates SQL (upserts, so it is safe to re-run) and applies it with
 * `wrangler d1 execute`. Products marked `available: false` get an inventory
 * row with 0 units; everything else is untracked until SKU.io pushes stock.
 * Never prints or needs a secret.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv.includes('--remote') ? '--remote' : '--local'
const root = new URL('..', import.meta.url).pathname
const products = JSON.parse(readFileSync(join(root, 'src/data/products.json'), 'utf8'))
const categories = JSON.parse(readFileSync(join(root, 'src/data/categories.json'), 'utf8'))
const sqlite = process.argv.includes('--sqlite')
const wranglerConfig = sqlite ? '' : readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
const dbName = /"database_name"\s*:\s*"([^"]+)"/.exec(wranglerConfig)?.[1]
if (!sqlite && !dbName) throw new Error('wrangler.jsonc has no d1_databases[].database_name')

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const now = new Date().toISOString()
const slugify = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200) || 'item'

const statements = []
categories.forEach((c, i) => {
  statements.push(
    `INSERT INTO categories (id, name, slug, parent_id, description_html, image_url, image_alt, position, created_at, updated_at) VALUES (${q(String(c.id))}, ${q(c.name)}, ${q(c.slug || slugify(c.name))}, ${q(c.parentId == null ? null : String(c.parentId))}, ${q(c.description ?? null)}, ${q(c.image?.src ?? null)}, ${q(c.image?.alt ?? null)}, ${c.position ?? i}, ${q(now)}, ${q(now)})
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, parent_id = excluded.parent_id, description_html = excluded.description_html, image_url = excluded.image_url, image_alt = excluded.image_alt, position = excluded.position, updated_at = excluded.updated_at`
  )
})
products.forEach((p, i) => {
  if (!Number.isInteger(p.price?.amount)) throw new Error(`${p.sku}: price.amount must be integer minor units`)
  statements.push(
    `INSERT INTO products (sku, name, slug, description_html, short_description_html, price_amount, currency, compare_at_amount, attributes_json, active, position, legacy_path, created_at, updated_at) VALUES (${q(p.sku)}, ${q(p.name)}, ${q(p.slug || slugify(p.name))}, ${q(p.description ?? null)}, ${q(p.shortDescription ?? null)}, ${p.price.amount}, ${q(String(p.price.currency).toLowerCase())}, ${q(p.compareAtPrice?.amount ?? null)}, ${q(JSON.stringify(p.attributes ?? {}))}, 1, ${p.position ?? i}, ${q(p.legacyPath ?? null)}, ${q(now)}, ${q(now)})
     ON CONFLICT (sku) DO UPDATE SET name = excluded.name, slug = excluded.slug, description_html = excluded.description_html, short_description_html = excluded.short_description_html, price_amount = excluded.price_amount, currency = excluded.currency, compare_at_amount = excluded.compare_at_amount, attributes_json = excluded.attributes_json, active = 1, position = excluded.position, legacy_path = excluded.legacy_path, updated_at = excluded.updated_at`
  )
  statements.push(`DELETE FROM product_categories WHERE sku = ${q(p.sku)}`)
  ;[...new Set(p.categoryIds ?? [])].forEach((id, pos) => statements.push(`INSERT INTO product_categories (sku, category_id, position) VALUES (${q(p.sku)}, ${q(String(id))}, ${pos})`))
  statements.push(`DELETE FROM product_images WHERE sku = ${q(p.sku)}`)
  const seen = new Set()
  ;(p.images ?? []).filter((img) => img?.src && !seen.has(img.src) && seen.add(img.src)).forEach((img, pos) => statements.push(`INSERT INTO product_images (sku, url, alt, position) VALUES (${q(p.sku)}, ${q(img.src)}, ${q(img.alt ?? null)}, ${pos})`))
  if (p.available === false) {
    statements.push(`INSERT INTO inventory (sku, available, allow_backorder, updated_at) VALUES (${q(p.sku)}, 0, 0, ${q(now)}) ON CONFLICT (sku) DO UPDATE SET available = 0, updated_at = excluded.updated_at`)
  }
})

if (sqlite) {
  const { runOnSqlite } = await import('./lib/sqlite.mjs')
  const file = await runOnSqlite(root, statements)
  console.log(`seed: done — ${categories.length} categories, ${products.length} products → ${file}`)
  process.exit(0)
}

// wrangler sends a file as one batch; keep each under D1's request limits.
const dir = mkdtempSync(join(tmpdir(), 'seed-store-'))
const CHUNK = 400
const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx'
for (let i = 0; i < statements.length; i += CHUNK) {
  const file = join(dir, `seed-${String(i / CHUNK).padStart(3, '0')}.sql`)
  writeFileSync(file, statements.slice(i, i + CHUNK).map((s) => s.replace(/\s+/g, ' ').trim() + ';').join('\n') + '\n')
  process.stdout.write(`seed: ${dbName} ${target} statements ${i + 1}-${Math.min(i + CHUNK, statements.length)} of ${statements.length}\n`)
  // A global CF_API_KEY in the environment breaks D1 calls; wrangler's own login is what we want.
  execFileSync(wrangler, ['wrangler', 'd1', 'execute', dbName, target, '--file', file], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CF_API_KEY: undefined, CF_API_EMAIL: undefined } })
}
console.log(`seed: done — ${categories.length} categories, ${products.length} products`)
