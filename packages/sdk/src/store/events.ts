import type { DbStatement } from '../db/driver'
import type { OrderEvent } from '../types'
import { parseJson, type StoreContext } from './context'

interface EventRow {
  id: number
  order_id: string
  type: string
  data_json: string | null
  created_at: string
}

/** The audit trail of an order: created, paid, cancelled, fulfilled, emails sent, … */
export class EventsService {
  constructor(private readonly ctx: StoreContext) {}

  /** A statement to include in a batch, so the event lands with the change it describes. */
  statement(orderId: string, type: string, data: Record<string, unknown> | null = null): DbStatement {
    return this.ctx.db
      .prepare(`INSERT INTO order_events (order_id, type, data_json, created_at) VALUES (?, ?, ?, ?)`)
      .bind(orderId, type, data ? JSON.stringify(data) : null, this.ctx.now())
  }

  async record(orderId: string, type: string, data: Record<string, unknown> | null = null): Promise<void> {
    await this.statement(orderId, type, data).run()
  }

  async list(orderId: string): Promise<OrderEvent[]> {
    const { results } = await this.ctx.db
      .prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC`)
      .bind(orderId)
      .all<EventRow>()
    return results.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      type: r.type,
      data: parseJson<Record<string, unknown> | null>(r.data_json, null),
      createdAt: r.created_at,
    }))
  }
}
