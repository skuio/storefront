import { findDiscount, publicDiscount, type PublicDiscount } from '../discounts'
import type { Money } from '../types'
import { parseJson, type StoreContext } from './context'
import { hashToken, secretsEqual } from './crypto'

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
