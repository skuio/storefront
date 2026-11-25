import type { APIContext } from 'astro'

/**
 * Which channel brought the buyer — recorded on every order, not only discount-code orders.
 *
 * A browser session forgets: someone who clicks an ad today and buys tomorrow looks "direct", and
 * the order the operations system receives carries no channel at all. Three cookies close that:
 *
 *   sf_ft  first touch — the first tagged or referred visit in 30 days; never overwritten
 *   sf_lt  last touch  — the latest TAGGED visit (utm_*, or an ad click id); overwritten each time
 *   sf_ck  ad clicks   — the latest click id VALUE per ad platform, kept 90 days (Google's longest
 *                        click-through window), so a later email or organic visit never erases it
 *
 * A touch is "tagged" when the URL carries utm_source or a click id: fbclid (Meta), gclid / gbraid /
 * wbraid (Google), ttclid (TikTok), msclkid (Microsoft). An untagged visit from another site counts
 * for first touch only — it is how organic search and links show up — and never displaces a paid
 * last touch.
 *
 * Checkout copies all of it onto the order's metadata, which the operations system reads through
 * the Store API:
 *
 *   src_first, src_first_at, src_last, src_last_at, src_last_click   the channel lines
 *   gclid | gbraid | wbraid, fbclid, msclkid, ttclid                  the click ids themselves
 *
 * SKU.io reads the click ids to tell which orders an ad drove and to report each order's profit
 * back to Google Ads / Meta. Google keeps one id (a new Google click replaces gclid, gbraid and
 * wbraid alike). A store whose landing page is prerendered never sees the query string server-side,
 * so Google's own conversion-linker cookies (`_gcl_aw`, `_gcl_gb`, set by gtag / GTM) are the
 * fallback when sf_ck has no Google click.
 *
 * httpOnly, first-party. Describe them on the store's privacy page under analytics/advertising.
 */

type Ctx = Pick<APIContext, 'url' | 'cookies' | 'request'>

export const FIRST = 'sf_ft'
export const LAST = 'sf_lt'
export const CLICKS = 'sf_ck'
const DAYS = 30
const CLICK_DAYS = 90
const CLICK_IDS: [string, string][] = [
  ['fbclid', 'meta'],
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['ttclid', 'tiktok'],
  ['msclkid', 'microsoft'],
]
/** The metadata keys checkout owns; a client-supplied value for any of them is dropped. */
export const CLICK_KEYS = CLICK_IDS.map(([k]) => k)
const OWNED = new Set(['src_first', 'src_first_at', 'src_last', 'src_last_at', 'src_last_click', ...CLICK_KEYS])

export interface Touch {
  source: string
  medium: string | null
  campaign: string | null
  content: string | null
  click: string | null // which click id was present (its value is kept in sf_ck)
  landing: string
  at: string
}

/** Latest click id per platform: `{ google: { k: 'gclid', v: '…', at: '…' }, meta: {…} }`. */
type Clicks = Record<string, { k: string; v: string; at: string }>

const clip = (s: string | null, n = 80) => (s ? s.trim().slice(0, n) : null)
/** Click ids are URL-safe tokens (gclid ~100 chars); anything else is not an id worth keeping. */
const clickValue = (v: string | null) => (v && /^[A-Za-z0-9._~-]{8,300}$/.test(v.trim()) ? v.trim() : null)

function touchFrom(ctx: Ctx): { touch: Touch; tagged: boolean } | null {
  const q = ctx.url.searchParams
  const click = CLICK_IDS.find(([k]) => q.has(k))
  const utm = q.get('utm_source')
  let refHost: string | null = null
  try {
    const r = ctx.request.headers.get('referer')
    refHost = r ? new URL(r).hostname.replace(/^www\./, '') : null
  } catch {
    refHost = null
  }
  if (refHost && refHost === ctx.url.hostname.replace(/^www\./, '')) refHost = null
  const tagged = !!(utm || click)
  const source = (utm ?? click?.[1] ?? refHost)?.toLowerCase()
  if (!source) return null
  return {
    tagged,
    touch: {
      source: source.slice(0, 40),
      medium: clip(q.get('utm_medium')) ?? (click ? 'paid' : tagged ? null : 'referral'),
      campaign: clip(q.get('utm_campaign')),
      content: clip(q.get('utm_content')),
      click: click?.[0] ?? null,
      landing: ctx.url.pathname.slice(0, 80),
      at: new Date().toISOString(),
    },
  }
}

function read<T>(ctx: Pick<APIContext, 'cookies'>, name: string): T | null {
  try {
    const v = ctx.cookies.get(name)?.value
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

/** Record first and last touch, and any ad click id, from this request's URL. Call from src/middleware.ts on page requests. */
export function captureTouch(ctx: Ctx): void {
  const secure = ctx.url.protocol === 'https:'
  const opts = (days: number) => ({ path: '/', maxAge: days * 86_400, sameSite: 'lax' as const, secure, httpOnly: true })

  const q = ctx.url.searchParams
  const seen = CLICK_IDS.map(([k, platform]) => ({ k, platform, v: clickValue(q.get(k)) })).filter((c) => c.v)
  if (seen.length) {
    const clicks = read<Clicks>(ctx, CLICKS) ?? {}
    const at = new Date().toISOString()
    for (const c of seen) clicks[c.platform] = { k: c.k, v: c.v as string, at }
    ctx.cookies.set(CLICKS, JSON.stringify(clicks), opts(CLICK_DAYS))
  }

  const t = touchFrom(ctx)
  if (!t) return
  const value = JSON.stringify(t.touch)
  if (!ctx.cookies.get(FIRST)?.value) ctx.cookies.set(FIRST, value, opts(DAYS))
  if (t.tagged) ctx.cookies.set(LAST, value, opts(DAYS))
}

/** "meta / paid / spring-launch / hero-video" — readable in SKU.io's order metadata. */
export const describe = (t: Touch) => [t.source, t.medium, t.campaign, t.content].filter(Boolean).join(' / ').slice(0, 200)

/** Google's conversion-linker cookie, `GCL.<unix seconds>.<id>`: the id, if it is recent enough to still count. */
function fromGcl(ctx: Pick<APIContext, 'cookies'>, name: string): string | null {
  const m = /^GCL\.(\d+)\.(.+)$/.exec(ctx.cookies.get(name)?.value ?? '')
  if (!m) return null
  if (Date.now() / 1000 - Number(m[1]) > CLICK_DAYS * 86_400) return null
  return clickValue(m[2])
}

/** The ad click ids for the order: one Google id (gclid, else gbraid, else wbraid) plus the other platforms'. */
export function clickMetadata(ctx: Pick<APIContext, 'cookies'>): Record<string, string> {
  const out: Record<string, string> = {}
  const clicks = read<Clicks>(ctx, CLICKS) ?? {}
  for (const c of Object.values(clicks)) {
    if (c && CLICK_KEYS.includes(c.k) && clickValue(c.v) && Date.now() - Date.parse(c.at) <= CLICK_DAYS * 86_400_000) out[c.k] = c.v
  }
  if (!out.gclid && !out.gbraid && !out.wbraid) {
    const gclid = fromGcl(ctx, '_gcl_aw')
    const gbraid = gclid ? null : fromGcl(ctx, '_gcl_gb')
    if (gclid) out.gclid = gclid
    else if (gbraid) out.gbraid = gbraid
  }
  return out
}

/** The order metadata checkout records: first and last touch (a line and a timestamp each), and the ad click ids. */
export function touchMetadata(ctx: Pick<APIContext, 'cookies'>): Record<string, string> {
  const out: Record<string, string> = {}
  const first = read<Touch>(ctx, FIRST)
  const last = read<Touch>(ctx, LAST) ?? first
  if (first) {
    out.src_first = describe(first)
    out.src_first_at = first.at
  }
  if (last) {
    out.src_last = describe(last)
    out.src_last_at = last.at
    if (last.click) out.src_last_click = last.click
  }
  return { ...out, ...clickMetadata(ctx) }
}

/**
 * Merge the attribution into an order's metadata. A client-supplied `metadata` never carries these
 * keys — they are the server's word — and they go first, so the checkout's 20-entry cap never cuts them.
 */
export function withTouchMetadata(ctx: Pick<APIContext, 'cookies'>, metadata?: Record<string, string>): Record<string, string> {
  const own = Object.fromEntries(Object.entries(metadata ?? {}).filter(([k]) => !OWNED.has(k)))
  return { ...touchMetadata(ctx), ...own }
}
