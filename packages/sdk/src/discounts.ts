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

/**
 * Quantity pricing: the more units in the order, the bigger the percentage off
 * the merchandise subtotal. Tiers count units across every line.
 *
 * It does not stack with a discount code: the buyer gets whichever saves
 * more, and a partner's code still attributes the order (and earns its
 * commission on what was actually charged) even when the tier wins.
 */
export interface QuantityDiscount {
  minQuantity: number
  percentOff: number
  /** Shown to the buyer, e.g. "Two-miner pack". Defaults to "Buy N+, save X%". */
  label?: string
}

export function validateQuantityDiscounts(tiers: QuantityDiscount[]): void {
  const seen = new Set<number>()
  for (const t of tiers) {
    if (!(Number.isInteger(t.minQuantity) && t.minQuantity >= 2)) throw new Error(`quantity discount minQuantity must be an integer >= 2, got ${t.minQuantity}`)
    if (!(t.percentOff > 0 && t.percentOff < 100)) throw new Error(`quantity discount for ${t.minQuantity}+ needs percentOff in (0, 100)`)
    if (seen.has(t.minQuantity)) throw new Error(`quantity discount for ${t.minQuantity}+ is defined twice`)
    seen.add(t.minQuantity)
  }
}

/** The best tier the unit count reaches, or null. */
export function quantityTier(tiers: QuantityDiscount[] | undefined, units: number): QuantityDiscount | null {
  return (tiers ?? []).filter((t) => units >= t.minQuantity).sort((a, b) => b.percentOff - a.percentOff)[0] ?? null
}

export function quantityLabel(t: QuantityDiscount): string {
  return t.label ?? `Buy ${t.minQuantity}+, save ${t.percentOff}%`
}

/**
 * Who a partner is, for the people they send and for their own portal.
 * `id` is what discount codes name in `partner`.
 */
export interface PartnerProfile {
  id: string
  /** Shown to visitors: "Welcome, friend of <name>". */
  name: string
  /** Where their portal sign-in link is sent. Without it they can only use a key link. */
  email?: string
  /** A line in their voice for the welcome banner, e.g. "Stack sats, solo mine, have fun." */
  welcome?: string
  /** Absolute URL or site path of a square photo or logo for the welcome banner. */
  avatar?: string
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
