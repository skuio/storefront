/**
 * The slice of Cloudflare D1's API the store uses. A `D1Database` binding
 * satisfies it as-is; tests satisfy it with better-sqlite3 (see test/sqlite.ts).
 *
 * Rules the store code follows so both back ends behave the same:
 *   - bind values are string | number | null | ArrayBuffer — never undefined or boolean
 *   - `first()`/`all()` only on statements that return rows
 *   - anything that must be atomic goes through `batch()`
 */
export interface DbStatement {
  bind(...values: DbValue[]): DbStatement
  first<T = Record<string, DbValue>>(): Promise<T | null>
  all<T = Record<string, DbValue>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>
}

export type DbValue = string | number | null | ArrayBuffer

export interface Database {
  prepare(sql: string): DbStatement
  batch<T = unknown>(statements: DbStatement[]): Promise<{ results: T[] }[]>
}

/** Coerce a value into something D1 accepts as a bind parameter. */
export function bindable(value: unknown): DbValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value instanceof ArrayBuffer) return value
  return JSON.stringify(value)
}
