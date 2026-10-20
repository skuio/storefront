import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database, DbStatement, DbValue } from './driver'

/**
 * The store's driver interface over a SQLite file, for hosts other than
 * Cloudflare (a Node server, a container, a VPS). Same SQL, same semantics as
 * D1: `batch()` is atomic, `first()` returns null on no rows, `run()` reports
 * changes. The SDK never imports a SQLite package: pass a better-sqlite3
 * `Database` (or anything with the same shape), the way the Stripe adapter
 * takes a Stripe client.
 *
 *   import BetterSqlite3 from 'better-sqlite3'
 *   const raw = new BetterSqlite3('data/store.db')
 *   migrateSqlite(raw, storefrontMigrations())
 *   const db = sqliteDatabase(raw)
 *
 * Node only (reads the shipped migrations from disk).
 */
export interface SqliteHandle {
  prepare(sql: string): SqliteStatement
  transaction(fn: () => unknown): () => unknown
  exec(sql: string): unknown
}

/* eslint-disable @typescript-eslint/no-explicit-any -- matches better-sqlite3's own parameter types */
export interface SqliteStatement {
  readonly reader: boolean
  get(...params: any[]): unknown
  all(...params: any[]): unknown[]
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

class Statement implements DbStatement {
  constructor(
    private readonly db: SqliteHandle,
    private readonly sql: string,
    private readonly values: DbValue[] = [],
  ) {}

  bind(...values: DbValue[]): DbStatement {
    for (const v of values) {
      if (v === undefined) throw new TypeError(`undefined bind value in: ${this.sql}`)
      if (typeof v === 'boolean') throw new TypeError(`boolean bind value in: ${this.sql}`)
    }
    return new Statement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql)
    if (!stmt.reader) throw new Error(`first() on a statement that returns no rows: ${this.sql}`)
    return (stmt.get(...this.values) as T | undefined) ?? null
  }

  async all<T>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.sql)
    if (!stmt.reader) throw new Error(`all() on a statement that returns no rows: ${this.sql}`)
    return { results: stmt.all(...this.values) as T[] }
  }

  async run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }> {
    return { meta: this.runSync() }
  }

  runSync(): { changes: number; last_row_id: number } {
    const stmt = this.db.prepare(this.sql)
    if (stmt.reader) {
      stmt.all(...this.values)
      return { changes: 0, last_row_id: 0 }
    }
    const info = stmt.run(...this.values)
    return { changes: info.changes, last_row_id: Number(info.lastInsertRowid) }
  }
}

/** The store's `Database` over a SQLite handle. */
export function sqliteDatabase(handle: SqliteHandle): Database {
  return {
    prepare(sql: string) {
      return new Statement(handle, sql)
    },
    async batch<T>(statements: DbStatement[]) {
      const tx = handle.transaction(() => statements.map((s) => ({ results: [] as T[], meta: (s as Statement).runSync() })))
      return tx() as { results: T[] }[]
    },
  }
}

export interface Migration {
  name: string
  sql: string
}

/** The schema migrations shipped with this package (`db/migrations/*.sql`), in order. */
export function storefrontMigrations(): Migration[] {
  const dir = migrationsDir()
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

/**
 * Apply the migrations this database has not seen yet, each in its own
 * transaction, recording them in `_storefront_migrations`. Safe to run on
 * every boot. Returns the names it applied.
 */
export function migrateSqlite(handle: SqliteHandle, migrations: Migration[]): string[] {
  handle.exec('CREATE TABLE IF NOT EXISTS _storefront_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const done = new Set((handle.prepare('SELECT name FROM _storefront_migrations').all() as { name: string }[]).map((r) => r.name))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    handle.transaction(() => {
      handle.exec(m.sql)
      handle.prepare('INSERT INTO _storefront_migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString())
    })()
    applied.push(m.name)
  }
  return applied
}

// The migrations ship at the package root. Walk up from this file (dist/ or
// dist/db/); if an app bundler inlined the SDK elsewhere, resolve the
// installed package from the working directory instead.
function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'db', 'migrations')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  try {
    const pkg = createRequire(join(process.cwd(), 'package.json')).resolve('@skuio/storefront/package.json')
    const candidate = join(dirname(pkg), 'db', 'migrations')
    if (existsSync(candidate)) return candidate
  } catch {
    /* not installed where we run */
  }
  throw new Error('@skuio/storefront: db/migrations not found; keep the package external to the server bundle (vite ssr.external)')
}
