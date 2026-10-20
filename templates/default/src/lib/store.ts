import type { APIContext } from 'astro'
import Stripe from 'stripe'
import { createStore, type Store } from '@skuio/storefront/store'
import { cloudflareMail, consoleMail, sendgridMail, type CloudflareSendEmailBinding, type MailAdapter } from '@skuio/storefront/mail'
import type { PaymentAdapter, PaymentContext } from '@skuio/storefront/payments'
import { manualPayments } from '@skuio/storefront/payments/manual'
import { stripePayments } from '@skuio/storefront/payments/stripe'
import { paypalPayments } from '@skuio/storefront/payments/paypal'
import { btcpayPayments } from '@skuio/storefront/payments/btcpay'
import { bitcoinPayments } from '@skuio/storefront/payments/bitcoin'
import config from '../../storefront.config'
// Hosting seam: astro.config.mjs points `~host` at host.cloudflare.ts or host.node.ts (STORE_HOST).
import { database, platformEnv } from '~host'

/**
 * The one place a page or endpoint gets the store from. Registry blocks
 * import { store, config, routes, readEnv, payment, paymentMethods, siteUrl } from here.
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
 * Secrets and settings: the platform's bindings first (the Worker env on
 * Cloudflare, `.dev.vars` under `astro dev`), then `.env` / the process
 * environment — which is all a Node host has. One code path for every host.
 */
export function readEnv(ctx: StoreContext, key: string): string | undefined {
  const runtimeEnv = platformEnv(ctx)
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
  const db = database(ctx)
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
 * Transactional mail. `MAIL_PROVIDER`:
 *   cloudflare — Cloudflare Email Service via the `send_email` binding named EMAIL
 *                (wrangler.jsonc) and a MAIL_FROM on a domain onboarded with
 *                `wrangler email sending enable <domain>`. No API key.
 *   sendgrid   — SENDGRID_API_KEY and a verified MAIL_FROM.
 *   console    — log every message (development; readable in `wrangler tail`).
 * Default: cloudflare when the binding exists, else sendgrid when its key exists, else console.
 */
export function mail(ctx: StoreContext): MailAdapter {
  const binding = platformEnv(ctx)?.EMAIL as CloudflareSendEmailBinding | undefined
  const from = readEnv(ctx, 'MAIL_FROM')
  const provider =
    readEnv(ctx, 'MAIL_PROVIDER') ?? (binding && from ? 'cloudflare' : readEnv(ctx, 'SENDGRID_API_KEY') && from ? 'sendgrid' : 'console')
  const sender = { email: from ?? '', name: readEnv(ctx, 'MAIL_FROM_NAME') ?? config.name }
  if (provider === 'cloudflare') {
    if (!binding || !from) {
      console.error('mail: MAIL_PROVIDER=cloudflare but the EMAIL binding or MAIL_FROM is missing; falling back to console')
      return consoleMail()
    }
    return cloudflareMail({ binding, from: sender })
  }
  if (provider === 'sendgrid') {
    const apiKey = readEnv(ctx, 'SENDGRID_API_KEY')
    if (!apiKey || !from) {
      console.error('mail: MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY / MAIL_FROM are not set; falling back to console')
      return consoleMail()
    }
    return sendgridMail({ apiKey, from: sender })
  }
  return consoleMail()
}

/**
 * The payment adapters, in the order the checkout offers them.
 * `PAYMENT_PROVIDER` is a comma list — `stripe`, `paypal`, `btcpay`, `manual`
 * — and defaults to `stripe` when a Stripe key exists, else `manual`. A store
 * on another processor adds its adapter to `adapterFor`.
 */
export function paymentMethods(ctx: StoreContext): PaymentAdapter[] {
  const ids = (readEnv(ctx, 'PAYMENT_PROVIDER') ?? (readEnv(ctx, 'STRIPE_SECRET_KEY') ? 'stripe' : 'manual'))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return [...new Set(ids)].map((id) => adapterFor(ctx, id))
}

/** One adapter: the one named `id` if the store offers it, else the default (first). */
export function payment(ctx: StoreContext, id?: string | null): PaymentAdapter {
  const all = paymentMethods(ctx)
  return (id ? all.find((a) => a.id === id) : undefined) ?? all[0]!
}

function adapterFor(ctx: StoreContext, id: string): PaymentAdapter {
  const required = (key: string) => {
    const value = readEnv(ctx, key)
    if (!value) throw new Error(`PAYMENT_PROVIDER includes ${id} but ${key} is not set`)
    return value
  }
  switch (id) {
    case 'stripe':
      return stripePayments({
        // Workers have no Node http stack; the fetch client and WebCrypto are required.
        stripe: new Stripe(required('STRIPE_SECRET_KEY'), { httpClient: Stripe.createFetchHttpClient() }),
        webhookSecret: readEnv(ctx, 'STRIPE_WEBHOOK_SECRET'),
        cryptoProvider: Stripe.createSubtleCryptoProvider(),
      })
    case 'paypal':
      return paypalPayments({
        clientId: required('PAYPAL_CLIENT_ID'),
        clientSecret: required('PAYPAL_CLIENT_SECRET'),
        webhookId: readEnv(ctx, 'PAYPAL_WEBHOOK_ID'),
        environment: readEnv(ctx, 'PAYPAL_ENV') === 'live' ? 'live' : 'sandbox',
      })
    case 'btcpay':
      return btcpayPayments({
        serverUrl: required('BTCPAY_URL'),
        storeId: required('BTCPAY_STORE_ID'),
        apiKey: required('BTCPAY_API_KEY'),
        webhookSecret: readEnv(ctx, 'BTCPAY_WEBHOOK_SECRET'),
      })
    case 'bitcoin':
      // On-chain, non-custodial: an account PUBLIC key (zpub) from a hardware wallet. Never a private key.
      return bitcoinPayments({ xpub: required('BITCOIN_XPUB'), ...(readEnv(ctx, 'BITCOIN_EXPLORER') ? { explorer: readEnv(ctx, 'BITCOIN_EXPLORER') } : {}) })
    case 'manual':
      return manualPayments()
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${id}"`)
  }
}

export function paymentContext(ctx: StoreContext): PaymentContext {
  return { store: store(ctx), siteUrl: siteUrl(ctx) }
}
