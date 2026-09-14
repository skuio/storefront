import type { APIContext } from 'astro'
import Stripe from 'stripe'
import { createStore, type Store } from '@skuio/storefront/store'
import { consoleMail, sendgridMail, type MailAdapter } from '@skuio/storefront/mail'
import type { PaymentAdapter, PaymentContext } from '@skuio/storefront/payments'
import { manualPayments } from '@skuio/storefront/payments/manual'
import { stripePayments } from '@skuio/storefront/payments/stripe'
import config from '../../storefront.config'

/**
 * The one place a page or endpoint gets the store from. Registry blocks
 * import { store, config, routes, readEnv, payment, siteUrl } from here.
 *
 * `store(Astro)` builds a Store over the D1 binding for this request and
 * memoises it on `Astro.locals`, so every component in the same request
 * shares one catalogue snapshot.
 */
export { config }
export const routes = config.routes

/** What a page (`Astro`) and an endpoint (`context`) have in common. */
export type StoreContext = Pick<APIContext, 'locals' | 'url' | 'request'>

/**
 * Secrets and settings: the Worker binding in production, `.dev.vars` under
 * `astro dev` (through the platform proxy), then `.env` / the process for
 * scripts and tests. One code path for local work and deploys.
 */
export function readEnv(ctx: StoreContext, key: string): string | undefined {
  const runtimeEnv = ctx.locals.runtime?.env as Record<string, unknown> | undefined
  const fromRuntime = runtimeEnv?.[key]
  if (typeof fromRuntime === 'string' && fromRuntime) return fromRuntime
  const fromMeta = (import.meta.env as Record<string, unknown>)[key]
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta
  const fromProcess = typeof process !== 'undefined' ? process.env?.[key] : undefined
  return typeof fromProcess === 'string' && fromProcess ? fromProcess : undefined
}

/** Absolute public origin for links in emails and processor return URLs. */
export function siteUrl(ctx: StoreContext): string {
  return (readEnv(ctx, 'PUBLIC_SITE_URL') ?? ctx.url.origin).replace(/\/+$/, '')
}

export function store(ctx: StoreContext): Store {
  if (ctx.locals.store) return ctx.locals.store
  const db = ctx.locals.runtime?.env?.DB
  if (!db) throw new Error('No D1 binding "DB". Add it to wrangler.jsonc and run `npm run db:migrate:local` (see README).')
  const env = {
    PUBLIC_SITE_URL: siteUrl(ctx),
    SESSION_SECRET: readEnv(ctx, 'SESSION_SECRET'),
    ORDER_NOTIFICATION_EMAIL: readEnv(ctx, 'ORDER_NOTIFICATION_EMAIL'),
  }
  const created = createStore({ db, config, env, mail: mail(ctx) })
  ctx.locals.store = created
  return created
}

/**
 * Transactional mail. `MAIL_PROVIDER=sendgrid` needs SENDGRID_API_KEY and a
 * verified MAIL_FROM; anything else logs the message (readable in `wrangler tail`).
 */
export function mail(ctx: StoreContext): MailAdapter {
  const provider = readEnv(ctx, 'MAIL_PROVIDER') ?? (readEnv(ctx, 'SENDGRID_API_KEY') && readEnv(ctx, 'MAIL_FROM') ? 'sendgrid' : 'console')
  if (provider === 'sendgrid') {
    const apiKey = readEnv(ctx, 'SENDGRID_API_KEY')
    const from = readEnv(ctx, 'MAIL_FROM')
    if (!apiKey || !from) {
      console.error('mail: MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY / MAIL_FROM are not set; falling back to console')
      return consoleMail()
    }
    return sendgridMail({ apiKey, from: { email: from, name: readEnv(ctx, 'MAIL_FROM_NAME') ?? config.name } })
  }
  return consoleMail()
}

/**
 * The payment adapter. `PAYMENT_PROVIDER=stripe` (default when a Stripe key
 * exists) or `manual` (pay later: the order waits until the operations
 * system marks it paid through the Store API). A store on another processor
 * adds its adapter here and can drop the Stripe import entirely.
 */
export function payment(ctx: StoreContext): PaymentAdapter {
  const provider = readEnv(ctx, 'PAYMENT_PROVIDER') ?? (readEnv(ctx, 'STRIPE_SECRET_KEY') ? 'stripe' : 'manual')
  if (provider === 'stripe') {
    const secretKey = readEnv(ctx, 'STRIPE_SECRET_KEY')
    if (!secretKey) throw new Error('PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is not set')
    return stripePayments({
      // Workers have no Node http stack; the fetch client and WebCrypto are required.
      stripe: new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() }),
      webhookSecret: readEnv(ctx, 'STRIPE_WEBHOOK_SECRET'),
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    })
  }
  if (provider === 'manual') return manualPayments()
  throw new Error(`Unknown PAYMENT_PROVIDER "${provider}"`)
}

export function paymentContext(ctx: StoreContext): PaymentContext {
  return { store: store(ctx), siteUrl: siteUrl(ctx) }
}
