import type { APIContext } from 'astro'
import { applyPaymentEvents } from '@skuio/storefront/payments'
import type { BitcoinPaymentAdapter } from '@skuio/storefront/payments/bitcoin'
import { paymentContext, paymentMethods, readEnv, store } from './store'

/**
 * Adapters with no webhook (on-chain bitcoin) are polled. Any request may
 * trigger a sweep, at most once a minute per Worker isolate, after the
 * response is sent (waitUntil) — the operations system's order poll alone
 * keeps it moving. Call from src/middleware.ts.
 */
let lastSweep = 0

export function sweepPayments(context: Pick<APIContext, 'locals' | 'url' | 'request'>): void {
  if (Date.now() - lastSweep < 60_000) return
  if (!(readEnv(context, 'PAYMENT_PROVIDER') ?? '').split(',').map((s) => s.trim()).includes('bitcoin')) return
  lastSweep = Date.now()
  const work = (async () => {
    const btc = paymentMethods(context).find((m) => m.id === 'bitcoin') as BitcoinPaymentAdapter | undefined
    if (!btc) return
    const events = await btc.sweep(paymentContext(context))
    const paid = events.filter((e) => e.type === 'paid')
    if (paid.length) await applyPaymentEvents(store(context), paid)
  })().catch((e) => console.warn('payment sweep failed', e))
  const waitUntil = (context.locals as { runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } }).runtime?.ctx?.waitUntil
  if (waitUntil) waitUntil(work)
}
