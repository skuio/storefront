import { ownerPasswordResetMail } from '../mail/templates'
import type { StoreContext } from './context'
import { hashToken, newId, randomToken } from './crypto'
import { StoreError } from './errors'
import { hashPassword, passwordProblem, verifyPassword } from './password'
import { RateLimiter } from './ratelimit'

export const OWNER_SESSION_DAYS = 14
export const OWNER_RESET_MINUTES = 30

export interface Owner {
  id: string
  email: string
  name: string | null
  createdAt: string
  lastSignedInAt: string | null
}

export interface OwnerSession {
  token: string
  expiresAt: string
  owner: Owner
}

export interface OwnerResetLink {
  token: string
  url: string
  expiresAt: string
  owner: Owner
}

interface OwnerRow {
  id: string
  email: string
  name: string | null
  password_hash: string
  created_at: string
  last_signed_in_at: string | null
}

const toOwner = (r: OwnerRow): Owner => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at, lastSignedInAt: r.last_signed_in_at })

export const normalizeOwnerEmail = (email: string) => email.trim().toLowerCase()

/**
 * The people who run the store. Password sign-in with a 14-day session, an
 * emailed reset link, and a failure counter per email + address so a guessed
 * password costs the guesser more than it costs the store.
 */
export class OwnersService {
  private readonly limiter: RateLimiter

  constructor(private readonly ctx: StoreContext) {
    this.limiter = new RateLimiter(ctx, { maxFailures: 10, windowMinutes: 15, lockMinutes: 15 })
  }

  private hash(token: string) {
    return hashToken(token, this.ctx.env.SESSION_SECRET)
  }

  async count(): Promise<number> {
    const row = await this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM owners`).first<{ n: number }>()
    return row?.n ?? 0
  }

  async byId(id: string): Promise<Owner | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM owners WHERE id = ?`).bind(id).first<OwnerRow>()
    return row ? toOwner(row) : null
  }

  async byEmail(email: string): Promise<Owner | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM owners WHERE email = ?`).bind(normalizeOwnerEmail(email)).first<OwnerRow>()
    return row ? toOwner(row) : null
  }

  async list(): Promise<Owner[]> {
    const { results } = await this.ctx.db.prepare(`SELECT * FROM owners ORDER BY created_at ASC`).all<OwnerRow>()
    return results.map(toOwner)
  }

  /** Create or, when the email exists, reset that owner's name and password. */
  async upsert(input: { email: string; name?: string | null; password: string }): Promise<Owner> {
    const email = normalizeOwnerEmail(input.email)
    if (!email.includes('@')) throw new StoreError('validation_failed', 'Invalid owner', { email: 'must be an email address' })
    const problem = passwordProblem(input.password)
    if (problem) throw new StoreError('validation_failed', 'Invalid owner', { password: problem })
    const now = this.ctx.now()
    const id = newId('own')
    await this.ctx.db
      .prepare(
        `INSERT INTO owners (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, owners.name), password_hash = excluded.password_hash`
      )
      .bind(id, email, input.name ?? null, await hashPassword(input.password), now)
      .run()
    return (await this.byEmail(email))!
  }

  /**
   * Password sign-in. Null on a wrong email or password — the caller shows one
   * generic message either way. Throws `rate_limited` while the email+address
   * pair is locked out.
   */
  async signIn(email: string, password: string, address: string): Promise<OwnerSession | null> {
    const normalized = normalizeOwnerEmail(email)
    const limitKey = `signin:${normalized}|${address}`
    await this.limiter.assertAllowed(limitKey, 'Too many sign-in attempts. Try again in a few minutes.')
    const row = await this.ctx.db.prepare(`SELECT * FROM owners WHERE email = ?`).bind(normalized).first<OwnerRow>()
    // Verify against a dummy hash when the email is unknown so timing does not reveal which emails exist.
    const check = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)
    if (!row || !check.ok) {
      await this.limiter.recordFailure(limitKey)
      return null
    }
    const now = this.ctx.now()
    const token = randomToken(32)
    const expiresAt = new Date(new Date(now).getTime() + OWNER_SESSION_DAYS * 86_400_000).toISOString()
    const statements = [
      this.ctx.db
        .prepare(`INSERT INTO owner_sessions (token_hash, owner_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(await this.hash(token), row.id, expiresAt, now, now),
      this.ctx.db.prepare(`UPDATE owners SET last_signed_in_at = ? WHERE id = ?`).bind(now, row.id),
      this.limiter.clearStatement(limitKey),
    ]
    if (check.needsRehash) statements.push(this.ctx.db.prepare(`UPDATE owners SET password_hash = ? WHERE id = ?`).bind(await hashPassword(password), row.id))
    await this.ctx.db.batch(statements)
    return { token, expiresAt, owner: { ...toOwner(row), lastSignedInAt: now } }
  }

  /** The owner behind a session token, or null when it is unknown or expired. */
  async resolve(token: string | null | undefined): Promise<Owner | null> {
    if (!token) return null
    const now = this.ctx.now()
    const hash = await this.hash(token)
    const row = await this.ctx.db
      .prepare(`SELECT owner_id, expires_at, last_seen_at FROM owner_sessions WHERE token_hash = ?`)
      .bind(hash)
      .first<{ owner_id: string; expires_at: string; last_seen_at: string }>()
    if (!row || row.expires_at <= now) return null
    if (new Date(now).getTime() - new Date(row.last_seen_at).getTime() > 3_600_000) {
      await this.ctx.db.prepare(`UPDATE owner_sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(now, hash).run()
    }
    return this.byId(row.owner_id)
  }

  async signOut(token: string | null | undefined): Promise<void> {
    if (!token) return
    await this.ctx.db.prepare(`DELETE FROM owner_sessions WHERE token_hash = ?`).bind(await this.hash(token)).run()
  }

  /** End every session of an owner (after a password reset). */
  async signOutEverywhere(ownerId: string): Promise<void> {
    await this.ctx.db.prepare(`DELETE FROM owner_sessions WHERE owner_id = ?`).bind(ownerId).run()
  }

  /** Create a reset link for a known owner; null for an unknown email (the caller answers the same either way). */
  async createResetLink(email: string): Promise<OwnerResetLink | null> {
    const owner = await this.byEmail(email)
    if (!owner) return null
    const token = randomToken(32)
    const now = this.ctx.now()
    const expiresAt = new Date(new Date(now).getTime() + OWNER_RESET_MINUTES * 60_000).toISOString()
    await this.ctx.db
      .prepare(`INSERT INTO owner_reset_links (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(await this.hash(token), owner.id, expiresAt, now)
      .run()
    return { token, url: `${this.ctx.siteUrl}/admin/reset-password/?token=${token}`, expiresAt, owner }
  }

  /** Email a reset link when the address belongs to an owner. Returns whether one was sent. */
  async sendResetLink(email: string): Promise<boolean> {
    const link = await this.createResetLink(email)
    if (!link) return false
    const mail = ownerPasswordResetMail({ url: link.url, expiresMinutes: OWNER_RESET_MINUTES }, { config: this.ctx.config, siteUrl: this.ctx.siteUrl })
    await this.ctx.mail.send({ to: link.owner.email, ...mail })
    return true
  }

  /** Exchange a reset token for a new password. Every existing session of that owner ends. */
  async resetPassword(token: string, password: string): Promise<Owner> {
    const problem = passwordProblem(password)
    if (problem) throw new StoreError('validation_failed', 'Invalid password', { password: problem })
    const now = this.ctx.now()
    const hash = await this.hash(token)
    const link = await this.ctx.db
      .prepare(`SELECT owner_id, expires_at, used_at FROM owner_reset_links WHERE token_hash = ?`)
      .bind(hash)
      .first<{ owner_id: string; expires_at: string; used_at: string | null }>()
    if (!link || link.used_at || link.expires_at <= now) throw new StoreError('not_found', 'This reset link is invalid, used or expired')
    const owner = await this.byId(link.owner_id)
    if (!owner) throw new StoreError('not_found', 'This reset link is invalid, used or expired')
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE owner_reset_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now, hash),
      this.ctx.db.prepare(`UPDATE owners SET password_hash = ? WHERE id = ?`).bind(await hashPassword(password), owner.id),
      this.ctx.db.prepare(`DELETE FROM owner_sessions WHERE owner_id = ?`).bind(owner.id),
    ])
    return owner
  }

  /** Housekeeping: drop expired sessions, used or expired reset links, and stale limiter rows. */
  async prune(): Promise<void> {
    const now = this.ctx.now()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`DELETE FROM owner_sessions WHERE expires_at <= ?`).bind(now),
      this.ctx.db.prepare(`DELETE FROM owner_reset_links WHERE expires_at <= ? OR used_at IS NOT NULL`).bind(now),
      this.limiter.pruneStatement(),
    ])
  }
}

// A real PBKDF2 hash of a random password, so unknown-email sign-ins cost the same time as known ones.
const DUMMY_HASH = '$pbkdf2-sha256$i=210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
