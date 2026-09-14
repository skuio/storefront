import type { DbStatement } from '../db/driver'
import type { StoreContext } from './context'
import { StoreError } from './errors'

export interface RateLimitPolicy {
  /** Failures allowed inside one window before the key locks. */
  maxFailures: number
  windowMinutes: number
  lockMinutes: number
}

/**
 * A failure counter in the database, keyed by whatever the caller wants to
 * throttle (sign-ins per email + address, code exchanges per address). Lives
 * in D1 rather than isolate memory so every Worker instance sees the same
 * count. Successes clear the key; nothing is counted for them.
 */
export class RateLimiter {
  constructor(private readonly ctx: StoreContext, private readonly policy: RateLimitPolicy) {}

  /** Throws `rate_limited` (429) while the key is locked. */
  async assertAllowed(key: string, message: string): Promise<void> {
    const now = this.ctx.now()
    const row = await this.ctx.db.prepare(`SELECT locked_until FROM auth_attempts WHERE key = ?`).bind(key).first<{ locked_until: string | null }>()
    if (row?.locked_until && row.locked_until > now) throw new StoreError('rate_limited', message)
  }

  async recordFailure(key: string): Promise<void> {
    const now = this.ctx.now()
    const nowMs = new Date(now).getTime()
    const row = await this.ctx.db
      .prepare(`SELECT failures, window_started_at, locked_until FROM auth_attempts WHERE key = ?`)
      .bind(key)
      .first<{ failures: number; window_started_at: string; locked_until: string | null }>()
    const inWindow = row && nowMs - new Date(row.window_started_at).getTime() < this.policy.windowMinutes * 60_000
    const failures = inWindow ? row!.failures + 1 : 1
    const windowStart = inWindow ? row!.window_started_at : now
    const lockedUntil = failures >= this.policy.maxFailures ? new Date(nowMs + this.policy.lockMinutes * 60_000).toISOString() : null
    await this.ctx.db
      .prepare(
        `INSERT INTO auth_attempts (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`
      )
      .bind(key, failures, windowStart, lockedUntil)
      .run()
  }

  clearStatement(key: string): DbStatement {
    return this.ctx.db.prepare(`DELETE FROM auth_attempts WHERE key = ?`).bind(key)
  }

  /** Rows whose window and lock have both passed carry no information; drop them. */
  pruneStatement(): DbStatement {
    const cutoff = new Date(new Date(this.ctx.now()).getTime() - Math.max(this.policy.windowMinutes, this.policy.lockMinutes) * 60_000).toISOString()
    return this.ctx.db.prepare(`DELETE FROM auth_attempts WHERE window_started_at <= ? AND (locked_until IS NULL OR locked_until <= ?)`).bind(cutoff, this.ctx.now())
  }
}
