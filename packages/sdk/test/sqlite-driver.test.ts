import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateSqlite, sqliteDatabase, storefrontMigrations } from '../src/db/sqlite'

describe('sqlite driver (non-Cloudflare hosts)', () => {
  it('applies every shipped migration once and records it', () => {
    const raw = new BetterSqlite3(':memory:')
    const all = storefrontMigrations()
    expect(all.length).toBeGreaterThan(0)
    expect(migrateSqlite(raw, all)).toEqual(all.map((m) => m.name))
    expect(migrateSqlite(raw, all)).toEqual([]) // safe on every boot
    const rows = raw.prepare('SELECT name FROM _storefront_migrations ORDER BY name').all() as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual(all.map((m) => m.name))
  })

  it('batch() is atomic and first() returns null on no rows, like D1', async () => {
    const raw = new BetterSqlite3(':memory:')
    raw.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
    const db = sqliteDatabase(raw)
    const insert = (id: string) => db.prepare('INSERT INTO t (id) VALUES (?)').bind(id)
    await expect(db.batch([insert('a'), insert('a')])).rejects.toThrow()
    expect(await db.prepare('SELECT id FROM t').first()).toBeNull()
    expect(() => db.prepare('SELECT 1').bind(undefined as never)).toThrow(/undefined bind/)
  })
})
