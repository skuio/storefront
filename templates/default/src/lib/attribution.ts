import type { APIContext } from 'astro'

/**
 * Which channel brought the buyer — recorded on every order, not only discount-code orders.
 *
 * A browser session forgets: someone who clicks an ad today and buys tomorrow looks "direct", and
 * the order the operations system receives carries no channel at all. Two cookies close that:
 *
 *   sf_ft  first touch — the first tagged or referred visit in 30 days; never overwritten
 *   sf_lt  last touch  — the latest TAGGED visit (utm_*, or an ad click id); overwritten each time
 *
 * A touch is "tagged" when the URL carries utm_source or a click id: fbclid (Meta), gclid / gbraid /
 * wbraid (Google), ttclid (TikTok), msclkid (Microsoft). An untagged visit from another site counts
 * for first touch only — it is how organic search and links show up — and never displaces a paid
 * last touch. Checkout copies both onto the order's metadata (`src_first`, `src_last`), which the
 * operations system reads through the Store API.
 *
 * httpOnly, 30 days, first-party. Describe it on the store's privacy page under analytics.
 */

type Ctx = Pick<APIContext, 'url' | 'cookies' | 'request'>

export const FIRST = 'sf_ft'
export const LAST = 'sf_lt'
const DAYS = 30
const CLICK_IDS: [string, string][] = [
  ['fbclid', 'meta'],
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['ttclid', 'tiktok'],
  ['msclkid', 'microsoft'],
]

export interface Touch {
  source: string
  medium: string | null
  campaign: string | null
  content: string | null
  click: string | null // which click id was present, not its value
  landing: string
  at: string
}

const clip = (s: string | null, n = 80) => (s ? s.trim().slice(0, n) : null)

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

/** Record first and last touch from this request's URL. Call from src/middleware.ts on page requests. */
export function captureTouch(ctx: Ctx): void {
  const t = touchFrom(ctx)
  if (!t) return
  const opts = { path: '/', maxAge: DAYS * 86_400, sameSite: 'lax' as const, secure: ctx.url.protocol === 'https:', httpOnly: true }
  const value = JSON.stringify(t.touch)
  if (!ctx.cookies.get(FIRST)?.value) ctx.cookies.set(FIRST, value, opts)
  if (t.tagged) ctx.cookies.set(LAST, value, opts)
}

function read(ctx: Pick<APIContext, 'cookies'>, name: string): Touch | null {
  try {
    const v = ctx.cookies.get(name)?.value
    return v ? (JSON.parse(v) as Touch) : null
  } catch {
    return null
  }
}

/** "meta / paid / spring-launch / hero-video" — readable in SKU.io's order metadata. */
export const describe = (t: Touch) => [t.source, t.medium, t.campaign, t.content].filter(Boolean).join(' / ').slice(0, 200)

/** The order metadata checkout records: first and last touch, each as a line and a timestamp. */
export function touchMetadata(ctx: Pick<APIContext, 'cookies'>): Record<string, string> {
  const out: Record<string, string> = {}
  const first = read(ctx, FIRST)
  const last = read(ctx, LAST) ?? first
  if (first) {
    out.src_first = describe(first)
    out.src_first_at = first.at
  }
  if (last) {
    out.src_last = describe(last)
    out.src_last_at = last.at
    if (last.click) out.src_last_click = last.click
  }
  return out
}
