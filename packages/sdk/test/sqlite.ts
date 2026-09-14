import BetterSqlite3 from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database, DbStatement, DbValue } from '../src/db/driver'

/**
 * The store's driver interface over better-sqlite3, so the same SQL and the
 * same service code run in tests as on D1. Mirrors D1's semantics: `batch()`
 * is atomic, `first()` returns null on no rows, `run()` reports changes.
 */
export interface TestDatabase extends Database {
  raw: BetterSqlite3.Database
  close(): void
}

class Statement implements DbStatement {
  constructor(private readonly db: BetterSqlite3.Database, private readonly sql: string, private readonly values: DbValue[] = []) {}

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

export function migrationsSql(): string {
  const dir = join(import.meta.dirname, '..', 'db', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

export function sqliteDatabase(file = ':memory:'): TestDatabase {
  const raw = new BetterSqlite3(file)
  raw.pragma('foreign_keys = ON')
  raw.exec(migrationsSql())
  return {
    raw,
    prepare(sql: string) {
      return new Statement(raw, sql)
    },
    async batch<T>(statements: DbStatement[]) {
      const tx = raw.transaction(() => statements.map((s) => ({ results: [] as T[], meta: (s as Statement).runSync() })))
      return tx()
    },
    close() {
      raw.close()
    },
  }
}
