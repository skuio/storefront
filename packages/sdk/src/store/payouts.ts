import type { DbStatement } from '../db/driver'
import type { PayoutAssignmentRow, PayoutAssignments } from '../payments'
import type { StoreContext } from './context'

/** Six bind values per row; D1 allows 100 per statement. */
const ROWS_PER_INSERT = 16

/** The `payout_line_assignments` table: which payout each processor transaction was fixed to. */
export class PayoutAssignmentsService {
  constructor(private readonly ctx: StoreContext) {}

  /** The record for one provider, in the shape payment adapters take. */
  forProvider(provider: string): PayoutAssignments {
    return {
      inRange: (scope, from, to) => this.inRange(provider, scope, from, to),
      assign: (scope, payoutId, rows) => this.assign(provider, scope, payoutId, rows),
    }
  }

  async inRange(provider: string, scope: string, from: string, to: string): Promise<Map<string, string>> {
    const { results } = await this.ctx.db
      .prepare(`SELECT transaction_id, payout_id FROM payout_line_assignments WHERE provider = ? AND scope = ? AND occurred_at >= ? AND occurred_at <= ?`)
      .bind(provider, scope, from, to)
      .all<{ transaction_id: string; payout_id: string }>()
    return new Map(results.map((r) => [r.transaction_id, r.payout_id]))
  }

  /** One batch, so a payout is recorded whole or not at all; a transaction already recorded keeps its payout. */
  async assign(provider: string, scope: string, payoutId: string, rows: PayoutAssignmentRow[]): Promise<void> {
    if (!rows.length) return
    const now = this.ctx.now()
    const statements: DbStatement[] = []
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const part = rows.slice(i, i + ROWS_PER_INSERT)
      statements.push(
        this.ctx.db
          .prepare(
            `INSERT OR IGNORE INTO payout_line_assignments (provider, scope, transaction_id, payout_id, occurred_at, assigned_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`
          )
          .bind(...part.flatMap((r) => [provider, scope, r.transactionId, payoutId, r.occurredAt, now]))
      )
    }
    await this.ctx.db.batch(statements)
  }
}
