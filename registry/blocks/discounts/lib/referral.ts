import type { APIContext } from 'astro'
import { DISCOUNT_COOKIE, normalizeDiscountCode } from '@skuio/storefront'
import { config, store } from './store'

type Ctx = Pick<APIContext, 'url' | 'cookies' | 'locals' | 'request'>

/**
 * A partner's link — any page with ?code=PODCAST — keeps that code applied
 * for `config.referral.cookieDays`. Only a code that is valid now is stored,
 * so a mistyped link never shows a dead code at checkout. Call from
 * src/middleware.ts before the page renders.
 */
export function captureReferral(context: Ctx): void {
  const raw = context.url.searchParams.get(config.referral.param)
  if (!raw) return
  const code = store(context).partners.lookupCode(raw)
  if (!code) return
  context.cookies.set(DISCOUNT_COOKIE, code.code, {
    path: '/',
    maxAge: config.referral.cookieDays * 86_400,
    sameSite: 'lax',
    secure: context.url.protocol === 'https:',
    httpOnly: false, // the checkout script reads it to show the code before the buyer types anything
  })
}

/** The code the buyer arrived with, if it is still valid. */
export function referredCode(context: Ctx): string | null {
  const raw = context.cookies.get(DISCOUNT_COOKIE)?.value
  return raw && store(context).partners.lookupCode(raw) ? normalizeDiscountCode(raw) : null
}
