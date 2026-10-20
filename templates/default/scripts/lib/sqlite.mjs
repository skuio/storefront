/**
 * Run SQL against the SQLite file a Node-hosted store uses (STORE_HOST=node),
 * the way the D1 scripts hand theirs to `wrangler d1 execute`. The file is
 * DATABASE_PATH (default data/store.db), migrated first with the schema that
 * ships in @skuio/storefront. One transaction: all statements or none.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export async function runOnSqlite(root, statements) {
  const require = createRequire(join(root, 'package.json'))
  const BetterSqlite3 = require('better-sqlite3')
  const sdkDir = dirname(require.resolve('@skuio/storefront/package.json'))
  const { migrateSqlite, storefrontMigrations } = await import(join(sdkDir, 'dist', 'db', 'sqlite.js'))
  const file = resolve(root, process.env.DATABASE_PATH ?? 'data/store.db')
  mkdirSync(dirname(file), { recursive: true })
  const raw = new BetterSqlite3(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  migrateSqlite(raw, storefrontMigrations())
  raw.transaction(() => statements.forEach((s) => raw.exec(s)))()
  raw.close()
  return file
}
