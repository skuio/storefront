/// <reference types="astro/client" />

/** Bindings and secrets the Worker receives. Locally, `.dev.vars` fills the secrets. */
interface StoreEnv {
  DB: D1Database
  ASSETS: Fetcher
  STORE_API_KEY?: string
  PAYMENT_PROVIDER?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  MAIL_PROVIDER?: string
  SENDGRID_API_KEY?: string
  MAIL_FROM?: string
  MAIL_FROM_NAME?: string
  SESSION_SECRET?: string
  PUBLIC_SITE_URL?: string
  ORDER_NOTIFICATION_EMAIL?: string
  CONTACT_NOTIFICATION_EMAIL?: string
}

type Runtime = import('@astrojs/cloudflare').Runtime<StoreEnv>

declare namespace App {
  interface Locals extends Runtime {
    /** Per-request store instance, memoised by src/lib/store.ts. */
    store?: import('@skuio/storefront/store').Store
  }
}
