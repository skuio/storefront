import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from '@skuio/storefront/store'
import { migrateSqlite, sqliteDatabase, storefrontMigrations } from '@skuio/storefront/db/sqlite'

/**
 * Hosting seam — any Node server (a VPS, a container, Render, Fly, Railway…).
 * Built with `STORE_HOST=node npm run build`, started with
 * `node dist/server/entry.mjs`. The database is one SQLite file at
 * DATABASE_PATH (default `data/store.db`; put it on a persistent volume),
 * migrated on first use. Secrets come from the process environment.
 */
type Ctx = { locals: App.Locals }

let db: Database | undefined

export function database(_ctx: Ctx): Database {
  if (db) return db
  const file = resolve(process.env.DATABASE_PATH ?? 'data/store.db')
  mkdirSync(dirname(file), { recursive: true })
  const raw = new BetterSqlite3(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  const applied = migrateSqlite(raw, storefrontMigrations())
  if (applied.length) console.log(`store: applied ${applied.length} migration(s) to ${file}`)
  db = sqliteDatabase(raw)
  return db
}

/** No platform bindings off Cloudflare: settings come from process.env through readEnv. */
export function platformEnv(_ctx: Ctx): Record<string, unknown> | undefined {
  return undefined
}
