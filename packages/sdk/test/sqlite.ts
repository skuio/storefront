import BetterSqlite3 from 'better-sqlite3'
import type { Database } from '../src/db/driver'
import { migrateSqlite, sqliteDatabase as overSqlite, storefrontMigrations } from '../src/db/sqlite'

/**
 * The store's driver interface over better-sqlite3 — the same driver a Node
 * host uses (`@skuio/storefront/db/sqlite`) — so the same SQL and the same
 * service code run in tests as on D1.
 */
export interface TestDatabase extends Database {
  raw: BetterSqlite3.Database
  close(): void
}

export function sqliteDatabase(file = ':memory:'): TestDatabase {
  const raw = new BetterSqlite3(file)
  raw.pragma('foreign_keys = ON')
  migrateSqlite(raw, storefrontMigrations())
  return {
    ...overSqlite(raw),
    raw,
    close() {
      raw.close()
    },
  }
}
