import { defineMiddleware } from 'astro:middleware'
import { captureReferral } from './lib/referral'

/** A partner's ?code= link keeps their discount applied through to checkout. */
export const onRequest = defineMiddleware((context, next) => {
  if (!context.isPrerendered) captureReferral(context)
  return next()
})
