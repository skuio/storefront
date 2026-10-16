import { formatMoney } from './money'

/**
 * Discount codes the store owns.
 *
 * A code lives in the store's configuration, is priced into the order by
 * `/api/checkout` like every other amount, and is recorded on the order —
 * so it works the same under any payment adapter, and a partner's sales are
 * read from the store's own orders rather than from a processor dashboard.
 *
 * A code may name a `partner` (an affiliate, a podcast, a reseller). The
 * order then carries that partner and the commission owed at the rate in
 * force when it was placed, so changing a rate later never rewrites history.
 */
export interface DiscountCode {
  /** What the buyer types. Matched case-insensitively, ignoring spaces. */
  code: string
  /** Percent off the merchandise subtotal, 1–100. Exactly one of percentOff / amountOff. */
  percentOff?: number
  /** Fixed amount off the merchandise subtotal, in minor units of the store currency. */
  amountOff?: number
  /** Shown to the buyer next to the code. Defaults to "15% off" / "$10 off". */
  label?: string
  /** Who the code attributes sales to. Orders placed with it are reported under this key. */
  partner?: string
  /** Commission owed to the partner, percent of the discounted merchandise subtotal (shipping and tax excluded). */
  commissionPercent?: number
  /** ISO timestamps; the code is valid from startsAt (inclusive) to endsAt (exclusive). */
  startsAt?: string
  endsAt?: string
  /** False switches the code off without deleting its history. Default true. */
  active?: boolean
}

/** What a buyer is shown about a code. Never includes the partner or the commission. */
export interface PublicDiscount {
  code: string
  label: string
  percentOff: number | null
  amountOff: number | null
}

/** How a code is carried from a partner's link to the checkout page. */
export interface ReferralSettings {
  /** Query parameter on any page that applies a code: /?code=PODCAST. */
  param: string
  /** How long the code stays applied in the buyer's browser. */
  cookieDays: number
}

export const DISCOUNT_COOKIE = 'sf_discount'

/** Canonical form of a code: upper case, no whitespace. */
export function normalizeDiscountCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase()
}

/** Throw on a configuration mistake; called from defineStorefront. */
export function validateDiscounts(codes: DiscountCode[], currency: string): void {
  const seen = new Set<string>()
  for (const d of codes) {
    const code = normalizeDiscountCode(d.code ?? '')
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new Error(`discount code "${d.code}" must be 2–40 letters, digits, - or _`)
    if (seen.has(code)) throw new Error(`discount code ${code} is defined twice`)
    seen.add(code)
    const hasPercent = d.percentOff !== undefined
    const hasAmount = d.amountOff !== undefined
    if (hasPercent === hasAmount) throw new Error(`discount code ${code} needs exactly one of percentOff or amountOff`)
    if (hasPercent && !(d.percentOff! > 0 && d.percentOff! <= 100)) throw new Error(`discount code ${code}: percentOff must be in (0, 100]`)
    if (hasAmount && !(Number.isInteger(d.amountOff) && d.amountOff! > 0)) throw new Error(`discount code ${code}: amountOff must be a positive integer of minor units (${currency})`)
    if (d.commissionPercent !== undefined && !(d.commissionPercent >= 0 && d.commissionPercent <= 100)) throw new Error(`discount code ${code}: commissionPercent must be in [0, 100]`)
    if (d.commissionPercent && !d.partner) throw new Error(`discount code ${code}: commissionPercent needs a partner to owe it to`)
    for (const k of ['startsAt', 'endsAt'] as const) if (d[k] && Number.isNaN(Date.parse(d[k]!))) throw new Error(`discount code ${code}: ${k} is not a date`)
  }
}

/** The code a buyer typed, if it is valid right now. */
export function findDiscount(codes: DiscountCode[] | undefined, input: string | null | undefined, now: Date = new Date()): DiscountCode | null {
  if (!codes?.length || !input) return null
  const wanted = normalizeDiscountCode(input)
  const d = codes.find((c) => normalizeDiscountCode(c.code) === wanted)
  if (!d || d.active === false) return null
  if (d.startsAt && now.getTime() < Date.parse(d.startsAt)) return null
  if (d.endsAt && now.getTime() >= Date.parse(d.endsAt)) return null
  return d
}

/** Minor units off a merchandise subtotal. Percentages round half up; never more than the subtotal. */
export function discountAmount(d: DiscountCode, subtotal: number): number {
  const raw = d.percentOff !== undefined ? Math.round((subtotal * d.percentOff) / 100) : d.amountOff ?? 0
  return Math.max(0, Math.min(raw, subtotal))
}

/** Commission owed on an order, in minor units, at the code's rate. */
export function commissionAmount(d: DiscountCode, subtotal: number, discount: number): number {
  if (!d.partner || !d.commissionPercent) return 0
  return Math.round(((subtotal - discount) * d.commissionPercent) / 100)
}

export function publicDiscount(d: DiscountCode, currency: string, locale = 'en-US'): PublicDiscount {
  const label =
    d.label ??
    (d.percentOff !== undefined
      ? `${d.percentOff}% off`
      : `${formatMoney({ amount: d.amountOff ?? 0, currency }, locale)} off`)
  return { code: normalizeDiscountCode(d.code), label, percentOff: d.percentOff ?? null, amountOff: d.amountOff ?? null }
}
