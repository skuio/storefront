import type { APIContext } from 'astro'
import { DISCOUNT_COOKIE, normalizeDiscountCode } from '@skuio/storefront'
import { config, store } from './store'

type Ctx = Pick<APIContext, 'url' | 'cookies' | 'locals' | 'request'>

/** Which channel brought the visitor (utm_source, else the referring host), for attributing their order. */
export const REFERRAL_SOURCE_COOKIE = 'sf_ref_src'

/**
 * A partner's link — any page with ?code=PODCAST — keeps that code applied
 * for `config.referral.cookieDays`, records the visit for the partner's
 * traffic report, and remembers the channel so the eventual order is credited
 * to it. Only a code that is valid now is stored, so a mistyped link never
 * shows a dead code at checkout. Call from src/middleware.ts before the page renders.
 */
export function captureReferral(context: Ctx): void {
  const raw = context.url.searchParams.get(config.referral.param)
  if (!raw) return
  const s = store(context)
  const code = s.partners.lookupCode(raw)
  if (!code) return
  const secure = context.url.protocol === 'https:'
  const maxAge = config.referral.cookieDays * 86_400
  context.cookies.set(DISCOUNT_COOKIE, code.code, { path: '/', maxAge, sameSite: 'lax', secure, httpOnly: false })

  const referral = s.partners.referral(code.code)
  if (!referral) return
  const q = context.url.searchParams
  const referrer = context.request.headers.get('referer')
  let referrerHost: string | null = null
  try {
    referrerHost = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : null
  } catch {
    referrerHost = null
  }
  if (referrerHost === context.url.hostname.replace(/^www\./, '')) referrerHost = null
  const source = (q.get('utm_source') ?? referrerHost ?? 'direct').toLowerCase().slice(0, 60)
  context.cookies.set(REFERRAL_SOURCE_COOKIE, source, { path: '/', maxAge, sameSite: 'lax', secure, httpOnly: true })

  const headers = context.request.headers
  const work = s.partners
    .recordVisit({
      partner: referral.partner.id,
      code: normalizeDiscountCode(code.code),
      ip: headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: headers.get('user-agent'),
      source,
      medium: q.get('utm_medium'),
      campaign: q.get('utm_campaign'),
      landingPath: context.url.pathname,
      country: headers.get('cf-ipcountry'),
    })
    .catch((e) => console.warn('referral: could not record visit', e))
  const waitUntil = (context.locals as { runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } }).runtime?.ctx?.waitUntil
  if (waitUntil) waitUntil(work)
}

/** The code the buyer arrived with, if it is still valid. */
export function referredCode(context: Ctx): string | null {
  const raw = context.cookies.get(DISCOUNT_COOKIE)?.value
  return raw && store(context).partners.lookupCode(raw) ? normalizeDiscountCode(raw) : null
}

/** The channel recorded with the referral, for the order's metadata. */
export function referredSource(context: Ctx): string | null {
  return context.cookies.get(REFERRAL_SOURCE_COOKIE)?.value ?? null
}
