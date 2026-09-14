import { magicLinkMail } from '../mail/templates'
import type { Customer } from '../types'
import type { StoreContext } from './context'
import { hashToken, randomToken } from './crypto'
import type { CustomersService } from './customers'
import { StoreError } from './errors'

export const MAGIC_LINK_MINUTES = 15
export const SESSION_DAYS = 30

export interface MagicLink {
  token: string
  url: string
  expiresAt: string
  customer: Customer
}

export interface Session {
  token: string
  expiresAt: string
  customer: Customer
}

/**
 * Passwordless sign-in. A magic link is a single-use token emailed to a known
 * customer; exchanging it creates a 30-day session. Only hashes are stored.
 */
export class SessionsService {
  constructor(private readonly ctx: StoreContext, private readonly customers: CustomersService) {}

  private hash(token: string) {
    return hashToken(token, this.ctx.env.SESSION_SECRET)
  }

  /** Create a link for a known customer; null for an unknown email (the caller answers the same either way). */
  async createMagicLink(email: string): Promise<MagicLink | null> {
    const customer = await this.customers.byEmail(email)
    if (!customer) return null
    const token = randomToken(32)
    const now = this.ctx.now()
    const expiresAt = new Date(new Date(now).getTime() + MAGIC_LINK_MINUTES * 60_000).toISOString()
    await this.ctx.db
      .prepare(`INSERT INTO magic_links (token_hash, customer_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(await this.hash(token), customer.id, expiresAt, now)
      .run()
    return { token, url: `${this.ctx.siteUrl}/account/verify/?token=${token}`, expiresAt, customer }
  }

  /** Email a sign-in link when the address belongs to a customer. Returns whether one was sent. */
  async sendMagicLink(email: string): Promise<boolean> {
    const link = await this.createMagicLink(email)
    if (!link) return false
    const mail = magicLinkMail({ url: link.url, expiresMinutes: MAGIC_LINK_MINUTES }, { config: this.ctx.config, siteUrl: this.ctx.siteUrl })
    await this.ctx.mail.send({ to: link.customer.email, ...mail })
    return true
  }

  /** Exchange a magic-link token for a session. Throws `not_found` when the link is unknown, used or expired. */
  async exchange(token: string): Promise<Session> {
    const now = this.ctx.now()
    const hash = await this.hash(token)
    const link = await this.ctx.db
      .prepare(`SELECT customer_id, expires_at, used_at FROM magic_links WHERE token_hash = ?`)
      .bind(hash)
      .first<{ customer_id: string; expires_at: string; used_at: string | null }>()
    if (!link || link.used_at || link.expires_at <= now) throw new StoreError('not_found', 'This sign-in link is invalid, used or expired')
    const customer = await this.customers.byId(link.customer_id)
    if (!customer) throw new StoreError('not_found', 'This sign-in link is invalid, used or expired')
    const sessionToken = randomToken(32)
    const expiresAt = new Date(new Date(now).getTime() + SESSION_DAYS * 86_400_000).toISOString()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now, hash),
      this.ctx.db
        .prepare(`INSERT INTO customer_sessions (token_hash, customer_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(await this.hash(sessionToken), customer.id, expiresAt, now, now),
    ])
    return { token: sessionToken, expiresAt, customer }
  }

  /** The customer behind a session token, or null when it is unknown or expired. */
  async resolve(token: string | null | undefined): Promise<Customer | null> {
    if (!token) return null
    const now = this.ctx.now()
    const hash = await this.hash(token)
    const row = await this.ctx.db
      .prepare(`SELECT customer_id, expires_at, last_seen_at FROM customer_sessions WHERE token_hash = ?`)
      .bind(hash)
      .first<{ customer_id: string; expires_at: string; last_seen_at: string }>()
    if (!row || row.expires_at <= now) return null
    if (new Date(now).getTime() - new Date(row.last_seen_at).getTime() > 3_600_000) {
      await this.ctx.db.prepare(`UPDATE customer_sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(now, hash).run()
    }
    return this.customers.byId(row.customer_id)
  }

  async signOut(token: string | null | undefined): Promise<void> {
    if (!token) return
    await this.ctx.db.prepare(`DELETE FROM customer_sessions WHERE token_hash = ?`).bind(await this.hash(token)).run()
  }

  /** Housekeeping: drop expired links and sessions. Safe to call from any request. */
  async prune(): Promise<void> {
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`DELETE FROM magic_links WHERE expires_at <= ? OR used_at IS NOT NULL`).bind(now),
      this.ctx.db.prepare(`DELETE FROM customer_sessions WHERE expires_at <= ?`).bind(now),
    ])
  }
}
