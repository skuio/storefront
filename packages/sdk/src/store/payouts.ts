import type { DbStatement } from '../db/driver'
import type { Payout, PayoutAssignments, PayoutLine, PayoutRecordLine, RecordedPayout } from '../payments'
import type { StoreContext } from './context'
import { randomToken } from './crypto'

/** Four bind values per line plus nine fixed; D1 allows 100 per statement. */
const LINES_PER_INSERT = 20
const IDS_PER_SELECT = 90

/**
 * `payout_records` / `payout_record_lines`: payouts recorded the first time they were served `paid`,
 * with every line in served order (see `PayoutAssignments`).
 */
export class PayoutAssignmentsService {
  constructor(private readonly ctx: StoreContext) {}

  /** The record for one provider, in the shape payment adapters take. */
  forProvider(provider: string): PayoutAssignments {
    return {
      recorded: (scope, accountId, payoutId) => this.recorded(provider, scope, accountId, payoutId),
      recordedAmong: (scope, accountId, payoutIds) => this.recordedAmong(provider, scope, accountId, payoutIds),
      recordedBetween: (scope, accountId, fromId, toId) => this.recordedBetween(provider, scope, accountId, fromId, toId),
      inRange: (scope, accountId, from, to) => this.inRange(provider, scope, accountId, from, to),
      finalize: (scope, accountId, payout, lines) => this.finalize(provider, scope, accountId, payout, lines),
      release: (scope, accountId, payoutId) => this.release(provider, scope, accountId, payoutId),
    }
  }

  async recorded(provider: string, scope: string, accountId: string, payoutId: string): Promise<RecordedPayout | null> {
    const row = await this.ctx.db
      .prepare(`SELECT payout_json FROM payout_records WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id = ?`)
      .bind(provider, accountId, scope, payoutId)
      .first<{ payout_json: string }>()
    if (!row) return null
    const { results } = await this.ctx.db
      .prepare(`SELECT line_json FROM payout_record_lines WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id = ? ORDER BY position ASC`)
      .bind(provider, accountId, scope, payoutId)
      .all<{ line_json: string }>()
    const lines = results.map((r) => JSON.parse(r.line_json) as PayoutLine)
    // A line another payout claimed first (UNIQUE transaction) was not written: count what is there.
    return { payout: { ...(JSON.parse(row.payout_json) as Payout), lineCount: lines.length }, lines }
  }

  async recordedAmong(provider: string, scope: string, accountId: string, payoutIds: string[]): Promise<Map<string, Payout>> {
    const out = new Map<string, Payout>()
    const ids = [...new Set(payoutIds)]
    for (let i = 0; i < ids.length; i += IDS_PER_SELECT) {
      const part = ids.slice(i, i + IDS_PER_SELECT)
      const { results } = await this.ctx.db
        .prepare(`SELECT payout_id, payout_json FROM payout_records WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id IN (${part.map(() => '?').join(', ')})`)
        .bind(provider, accountId, scope, ...part)
        .all<{ payout_id: string; payout_json: string }>()
      for (const r of results) out.set(r.payout_id, JSON.parse(r.payout_json) as Payout)
    }
    return out
  }

  async recordedBetween(provider: string, scope: string, accountId: string, fromId: string, toId: string): Promise<Map<string, Payout>> {
    const { results } = await this.ctx.db
      .prepare(`SELECT payout_id, payout_json FROM payout_records WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id >= ? AND payout_id <= ?`)
      .bind(provider, accountId, scope, fromId, toId)
      .all<{ payout_id: string; payout_json: string }>()
    return new Map(results.map((r) => [r.payout_id, JSON.parse(r.payout_json) as Payout]))
  }

  async inRange(provider: string, scope: string, accountId: string, from: string, to: string): Promise<Map<string, string>> {
    const { results } = await this.ctx.db
      .prepare(
        `SELECT transaction_id, payout_id FROM payout_record_lines WHERE provider = ? AND account_id = ? AND scope = ? AND occurred_at >= ? AND occurred_at <= ? AND transaction_id IS NOT NULL`
      )
      .bind(provider, accountId, scope, from, to)
      .all<{ transaction_id: string; payout_id: string }>()
    return new Map(results.map((r) => [r.transaction_id, r.payout_id]))
  }

  /**
   * One batch (one transaction): the marker with this request's token, then the lines, each insert
   * conditioned on that token being the marker's — so only the request that recorded the marker writes
   * lines, and a payout is recorded whole or not at all. Then reads back whatever is recorded.
   */
  async finalize(provider: string, scope: string, accountId: string, payout: Payout, lines: PayoutRecordLine[]): Promise<RecordedPayout> {
    const token = randomToken(16)
    const key = [provider, accountId, scope, payout.id] as const
    const statements: DbStatement[] = [
      this.ctx.db
        .prepare(`INSERT OR IGNORE INTO payout_records (provider, account_id, scope, payout_id, token, payout_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(...key, token, JSON.stringify({ ...payout, lineCount: lines.length }), this.ctx.now()),
    ]
    for (let i = 0; i < lines.length; i += LINES_PER_INSERT) {
      const part = lines.slice(i, i + LINES_PER_INSERT)
      statements.push(
        this.ctx.db
          .prepare(
            `INSERT OR IGNORE INTO payout_record_lines (provider, account_id, scope, payout_id, position, transaction_id, occurred_at, line_json) ` +
              `SELECT ?, ?, ?, ?, v.column1, v.column2, v.column3, v.column4 FROM (VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}) AS v ` +
              `WHERE EXISTS (SELECT 1 FROM payout_records WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id = ? AND token = ?)`
          )
          .bind(...key, ...part.flatMap((l, j) => [i + j, l.transactionId, l.occurredAt, JSON.stringify(l.line)]), ...key, token)
      )
    }
    await this.ctx.db.batch(statements)
    const stored = await this.recorded(provider, scope, accountId, payout.id)
    if (!stored) throw new Error(`payout ${payout.id} was not recorded`)
    return stored
  }

  async release(provider: string, scope: string, accountId: string, payoutId: string): Promise<void> {
    await this.ctx.db.batch([
      this.ctx.db.prepare(`DELETE FROM payout_record_lines WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id = ?`).bind(provider, accountId, scope, payoutId),
      this.ctx.db.prepare(`DELETE FROM payout_records WHERE provider = ? AND account_id = ? AND scope = ? AND payout_id = ?`).bind(provider, accountId, scope, payoutId),
    ])
  }
}
