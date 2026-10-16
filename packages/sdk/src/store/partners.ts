import { findDiscount, normalizeDiscountCode, publicDiscount, type PartnerProfile, type PublicDiscount } from '../discounts'
import { partnerSignInMail } from '../mail/templates'
import type { Money } from '../types'
import { parseJson, type StoreContext } from './context'
import { hashToken, randomToken, secretsEqual, sha256Hex } from './crypto'
import { StoreError } from './errors'

export const PARTNER_LINK_MINUTES = 15
export const PARTNER_SESSION_DAYS = 30
/** A second visit from the same visitor within this window is the same visit. */
const VISIT_DEDUPE_MINUTES = 30

export interface VisitInput {
  partner: string
  code: string
  /** Used only to derive the daily visitor hash; never stored. */
  ip: string | null
  userAgent: string | null
  source?: string | null
  medium?: string | null
  campaign?: string | null
  landingPath?: string | null
  country?: string | null
}

export interface TrafficDay {
  day: string
  visits: number
  visitors: number
  checkouts: number
  orders: number
}

export interface TrafficSource {
  source: string
  visits: number
  visitors: number
  orders: number
  sales: Money
}

export interface PartnerTraffic {
  days: number
  totals: { visits: number; visitors: number; checkouts: number; orders: number; conversion: number; sales: Money; commission: Money }
  byDay: TrafficDay[]
  bySource: TrafficSource[]
  byCountry: { country: string; visits: number }[]
}

export interface PartnerReportOptions {
  /** ISO lower bound on when the order was placed. */
  since?: string
  /** Days after payment before a commission counts as payable (the refund window). Default 30. */
  holdDays?: number
}

/** One attributed order as a partner may see it: no buyer name, email or address beyond the country. */
export interface PartnerReportLine {
  number: string
  placedAt: string
  paidAt: string | null
  country: string | null
  units: number
  /** Merchandise after the discount; shipping and tax excluded. */
  merchandise: Money
  commission: Money
  state: 'payable' | 'held' | 'void'
}

export interface PartnerReport {
  partner: string
  codes: PublicDiscount[]
  lines: PartnerReportLine[]
  totals: { orders: number; units: number; merchandise: Money; payable: Money; held: Money }
}

interface Row {
  number: number
  created_at: string
  paid_at: string | null
  status: string
  payment_status: string
  currency: string
  subtotal: number
  discount: number
  partner_commission: number
  shipping_address_json: string
  units: number | null
}

/**
 * Who sold what with which code. A partner's report reads the store's own
 * orders, so it covers every payment adapter; it is shown to the partner
 * through a link keyed by an HMAC of their id, never by a password.
 */
export class PartnersService {
  constructor(private readonly ctx: StoreContext) {}

  /** A partner's public profile; falls back to the id as the name when none is configured. */
  profile(id: string): PartnerProfile {
    return this.ctx.config.partners.find((p) => p.id === id) ?? { id, name: id }
  }

  /** The partner a code attributes to, with its public discount — for the welcome banner. */
  referral(code: string | null | undefined): { partner: PartnerProfile; discount: PublicDiscount } | null {
    const d = findDiscount(this.ctx.config.discounts, code, new Date(this.ctx.now()))
    if (!d?.partner) return null
    return { partner: this.profile(d.partner), discount: publicDiscount(d, this.ctx.config.currency, this.ctx.config.locale) }
  }

  // ── Traffic ─────────────────────────────────────────────────────────────

  /** Record a visit through a partner link. Same visitor within 30 minutes counts once. Returns whether it was recorded. */
  async recordVisit(v: VisitInput): Promise<boolean> {
    if (!this.partners().includes(v.partner)) return false
    const now = this.ctx.now()
    const visitor = (await sha256Hex(`${this.ctx.env.SESSION_SECRET ?? ''}|${now.slice(0, 10)}|${v.ip ?? ''}|${v.userAgent ?? ''}`)).slice(0, 20)
    const since = new Date(Date.parse(now) - VISIT_DEDUPE_MINUTES * 60_000).toISOString()
    const seen = await this.ctx.db
      .prepare(`SELECT 1 AS x FROM referral_visits WHERE partner = ? AND visitor = ? AND created_at >= ? LIMIT 1`)
      .bind(v.partner, visitor, since)
      .first<{ x: number }>()
    if (seen) return false
    const clip = (x: string | null | undefined, n: number) => (x ? x.slice(0, n) : null)
    await this.ctx.db
      .prepare(`INSERT INTO referral_visits (partner, code, visitor, source, medium, campaign, landing_path, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(v.partner, normalizeDiscountCode(v.code), visitor, clip(v.source?.toLowerCase(), 60) ?? 'direct', clip(v.medium?.toLowerCase(), 60), clip(v.campaign, 80), clip(v.landingPath, 200), clip(v.country?.toUpperCase(), 2), now)
      .run()
    return true
  }

  /**
   * The funnel for one partner over the last `days`: visits and unique visitors through their
   * links, checkouts started with their code, paid orders, conversion (paid ÷ unique visitors),
   * by day, by source and by country. Orders carry the source of the visit that brought them
   * (metadata `ref_source`) so a channel's sales can be told apart; a spoken code shows as 'code'.
   */
  async traffic(partner: string, opts: { days?: number } = {}): Promise<PartnerTraffic> {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365)
    const currency = this.ctx.config.currency
    const now = Date.parse(this.ctx.now())
    const since = new Date(now - days * 86_400_000).toISOString()
    const db = this.ctx.db
    const visitsByDay = (
      await db
        .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM referral_visits WHERE partner = ? AND created_at >= ? GROUP BY day`)
        .bind(partner, since)
        .all<{ day: string; visits: number; visitors: number }>()
    ).results
    const ordersByDay = (
      await db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS checkouts, SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS orders
             FROM orders WHERE discount_partner = ? AND created_at >= ? GROUP BY day`
        )
        .bind(partner, since)
        .all<{ day: string; checkouts: number; orders: number }>()
    ).results
    const byDayMap = new Map<string, TrafficDay>()
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10)
      byDayMap.set(day, { day, visits: 0, visitors: 0, checkouts: 0, orders: 0 })
    }
    for (const r of visitsByDay) Object.assign(byDayMap.get(r.day) ?? {}, { visits: r.visits, visitors: r.visitors })
    for (const r of ordersByDay) Object.assign(byDayMap.get(r.day) ?? {}, { checkouts: r.checkouts, orders: r.orders ?? 0 })

    const totalsRow = await db
      .prepare(`SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor || substr(created_at, 1, 10)) AS visitors FROM referral_visits WHERE partner = ? AND created_at >= ?`)
      .bind(partner, since)
      .first<{ visits: number; visitors: number }>()
    const orderTotals = await db
      .prepare(
        `SELECT COUNT(*) AS checkouts,
                SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS orders,
                SUM(CASE WHEN payment_status = 'paid' THEN subtotal - discount ELSE 0 END) AS sales,
                SUM(CASE WHEN payment_status = 'paid' THEN partner_commission ELSE 0 END) AS commission
           FROM orders WHERE discount_partner = ? AND created_at >= ?`
      )
      .bind(partner, since)
      .first<{ checkouts: number; orders: number | null; sales: number | null; commission: number | null }>()

    const sources = (
      await db
        .prepare(`SELECT COALESCE(source, 'direct') AS source, COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors FROM referral_visits WHERE partner = ? AND created_at >= ? GROUP BY source ORDER BY visits DESC LIMIT 20`)
        .bind(partner, since)
        .all<{ source: string; visits: number; visitors: number }>()
    ).results
    const orderSources = (
      await db
        .prepare(
          `SELECT COALESCE(json_extract(metadata_json, '$.ref_source'), 'code') AS source, COUNT(*) AS orders, SUM(subtotal - discount) AS sales
             FROM orders WHERE discount_partner = ? AND created_at >= ? AND payment_status = 'paid' GROUP BY source`
        )
        .bind(partner, since)
        .all<{ source: string; orders: number; sales: number }>()
    ).results
    const bySourceMap = new Map<string, TrafficSource>()
    for (const r of sources) bySourceMap.set(r.source, { source: r.source, visits: r.visits, visitors: r.visitors, orders: 0, sales: { amount: 0, currency } })
    for (const r of orderSources) {
      const row = bySourceMap.get(r.source) ?? { source: r.source, visits: 0, visitors: 0, orders: 0, sales: { amount: 0, currency } }
      row.orders = r.orders
      row.sales = { amount: r.sales ?? 0, currency }
      bySourceMap.set(r.source, row)
    }
    const byCountry = (
      await db
        .prepare(`SELECT COALESCE(country, '??') AS country, COUNT(*) AS visits FROM referral_visits WHERE partner = ? AND created_at >= ? GROUP BY country ORDER BY visits DESC LIMIT 10`)
        .bind(partner, since)
        .all<{ country: string; visits: number }>()
    ).results

    const visitors = totalsRow?.visitors ?? 0
    const orders = orderTotals?.orders ?? 0
    return {
      days,
      totals: {
        visits: totalsRow?.visits ?? 0,
        visitors,
        checkouts: orderTotals?.checkouts ?? 0,
        orders,
        conversion: visitors ? orders / visitors : 0,
        sales: { amount: orderTotals?.sales ?? 0, currency },
        commission: { amount: orderTotals?.commission ?? 0, currency },
      },
      byDay: [...byDayMap.values()],
      bySource: [...bySourceMap.values()].sort((a, b) => b.visits - a.visits || b.orders - a.orders),
      byCountry,
    }
  }

  // ── Sign-in ─────────────────────────────────────────────────────────────

  private tokenHash(token: string) {
    return hashToken(`partner:${token}`, this.ctx.env.SESSION_SECRET)
  }

  /** Email a sign-in link when the address belongs to a partner. Answers the same either way. */
  async sendSignInLink(email: string): Promise<boolean> {
    const wanted = email.trim().toLowerCase()
    const partner = this.ctx.config.partners.find((p) => p.email?.toLowerCase() === wanted)
    if (!partner?.email) return false
    const token = randomToken(32)
    const now = this.ctx.now()
    const expiresAt = new Date(Date.parse(now) + PARTNER_LINK_MINUTES * 60_000).toISOString()
    await this.ctx.db
      .prepare(`INSERT INTO partner_magic_links (token_hash, partner, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(await this.tokenHash(token), partner.id, expiresAt, now)
      .run()
    const url = `${this.ctx.siteUrl}/partners/verify/?token=${token}`
    const mail = partnerSignInMail({ url, name: partner.name, expiresMinutes: PARTNER_LINK_MINUTES }, { config: this.ctx.config, siteUrl: this.ctx.siteUrl })
    await this.ctx.mail.send({ to: partner.email, ...mail })
    return true
  }

  /** Exchange a sign-in link for a session. Throws `not_found` when the link is unknown, used or expired. */
  async exchange(token: string): Promise<{ token: string; expiresAt: string; partner: string }> {
    const now = this.ctx.now()
    const hash = await this.tokenHash(token)
    const link = await this.ctx.db
      .prepare(`SELECT partner, expires_at, used_at FROM partner_magic_links WHERE token_hash = ?`)
      .bind(hash)
      .first<{ partner: string; expires_at: string; used_at: string | null }>()
    if (!link || link.used_at || link.expires_at <= now || !this.partners().includes(link.partner)) {
      throw new StoreError('not_found', 'This sign-in link is invalid, used or expired')
    }
    const session = randomToken(32)
    const expiresAt = new Date(Date.parse(now) + PARTNER_SESSION_DAYS * 86_400_000).toISOString()
    await this.ctx.db.batch([
      this.ctx.db.prepare(`UPDATE partner_magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now, hash),
      this.ctx.db
        .prepare(`INSERT INTO partner_sessions (token_hash, partner, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(await this.tokenHash(session), link.partner, expiresAt, now, now),
    ])
    return { token: session, expiresAt, partner: link.partner }
  }

  /** The partner behind a session token, or null. */
  async resolveSession(token: string | null | undefined): Promise<string | null> {
    if (!token) return null
    const row = await this.ctx.db
      .prepare(`SELECT partner, expires_at FROM partner_sessions WHERE token_hash = ?`)
      .bind(await this.tokenHash(token))
      .first<{ partner: string; expires_at: string }>()
    if (!row || row.expires_at <= this.ctx.now() || !this.partners().includes(row.partner)) return null
    return row.partner
  }

  async signOut(token: string | null | undefined): Promise<void> {
    if (!token) return
    await this.ctx.db.prepare(`DELETE FROM partner_sessions WHERE token_hash = ?`).bind(await this.tokenHash(token)).run()
  }

  /** A code as the buyer sees it, if it is valid now. */
  lookupCode(input: string | null | undefined): PublicDiscount | null {
    const d = findDiscount(this.ctx.config.discounts, input, new Date(this.ctx.now()))
    return d ? publicDiscount(d, this.ctx.config.currency, this.ctx.config.locale) : null
  }

  /** Partners named by the configured codes. */
  partners(): string[] {
    return [...new Set(this.ctx.config.discounts.map((d) => d.partner).filter((p): p is string => !!p))]
  }

  /** The secret in a partner's report link. Needs SESSION_SECRET; rotating it revokes every link. */
  async reportKey(partner: string): Promise<string> {
    const secret = this.ctx.env.SESSION_SECRET
    if (!secret) throw new Error('SESSION_SECRET is required for partner report links')
    return (await hashToken(`partner-report:${partner}`, secret)).slice(0, 32)
  }

  async verifyReportKey(partner: string, key: string | null | undefined): Promise<boolean> {
    if (!key || !this.partners().includes(partner) || !this.ctx.env.SESSION_SECRET) return false
    return secretsEqual(key, await this.reportKey(partner))
  }

  async report(partner: string, options: PartnerReportOptions = {}): Promise<PartnerReport> {
    const holdMs = (options.holdDays ?? 30) * 86_400_000
    const now = Date.parse(this.ctx.now())
    const currency = this.ctx.config.currency
    const { results } = await this.ctx.db
      .prepare(
        `SELECT o.number, o.created_at, o.paid_at, o.status, o.payment_status, o.currency, o.subtotal, o.discount, o.partner_commission,
                o.shipping_address_json, (SELECT SUM(quantity) FROM order_lines l WHERE l.order_id = o.id) AS units
           FROM orders o
          WHERE o.discount_partner = ? AND o.payment_status IN ('paid', 'refunded') AND o.created_at >= ?
          ORDER BY o.created_at DESC`
      )
      .bind(partner, options.since ?? '0000')
      .all<Row>()
    const lines: PartnerReportLine[] = results.map((r) => {
      const voided = r.payment_status === 'refunded' || r.status === 'cancelled' || r.status === 'refunded'
      const settled = r.paid_at ? now - Date.parse(r.paid_at) >= holdMs : false
      return {
        number: `${this.ctx.config.orders.numberPrefix}${r.number}`,
        placedAt: r.created_at,
        paidAt: r.paid_at,
        country: parseJson<{ country?: string }>(r.shipping_address_json, {}).country ?? null,
        units: r.units ?? 0,
        merchandise: { amount: r.subtotal - r.discount, currency: r.currency },
        commission: { amount: voided ? 0 : r.partner_commission, currency: r.currency },
        state: voided ? 'void' : settled ? 'payable' : 'held',
      }
    })
    const sum = (pick: (l: PartnerReportLine) => number) => lines.reduce((n, l) => n + pick(l), 0)
    const live = lines.filter((l) => l.state !== 'void')
    return {
      partner,
      codes: this.ctx.config.discounts.filter((d) => d.partner === partner).map((d) => this.lookupCode(d.code) ?? { ...publicDiscount(d, currency, this.ctx.config.locale), label: 'expired' }),
      lines,
      totals: {
        orders: live.length,
        units: live.reduce((n, l) => n + l.units, 0),
        merchandise: { amount: live.reduce((n, l) => n + l.merchandise.amount, 0), currency },
        payable: { amount: sum((l) => (l.state === 'payable' ? l.commission.amount : 0)), currency },
        held: { amount: sum((l) => (l.state === 'held' ? l.commission.amount : 0)), currency },
      },
    }
  }
}
