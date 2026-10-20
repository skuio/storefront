# The store platform (v2)

The storefront kit is a **self-contained e-commerce platform**: a site built on it owns its
catalog, customers, orders, payments and buyer portal in its **own database**, and exposes
a **Store API** so an operations system (SKU.io first) can pull orders and push inventory,
fulfilments and products. Think of it as a WooCommerce replacement that is not WordPress: an
Astro site with a SQLite-family database behind it: Cloudflare Workers + D1 by default, or any
Node server with a SQLite file. Nothing in the platform depends on the host either.

Nothing in the platform depends on a particular payment processor or operations system.
Payments are **adapters** (`stripe`, `manual`, …); the operations system talks only to the
Store API and never to the processor.

```
buyer ──▶ store (Astro + its DB) ◀────────── Store API ◀── SKU.io Storefront integration
             │  ▲                                        (pulls orders, pushes inventory,
             ▼  │ webhook / return                        tracking and products)
        payment adapter (Stripe, manual, …)
```

## What lives where

| Concern | Owner | Notes |
|---|---|---|
| Catalog (products, categories, images, prices) | Store DB | Pushed by SKU.io (`PUT /products`, `PUT /categories`); can also be seeded from a file. |
| Availability | Store DB | Pushed by SKU.io (`PUT /inventory`); status is derived from `available` + thresholds. |
| Cart, checkout, order creation | Store | Prices are read from the store DB at checkout, never from the client. |
| Payment | Payment adapter | Stripe hosted Checkout today; `manual` (pay later) ships as the second adapter and the proof that the pipeline is processor-neutral. |
| Orders, payments, fulfilments | Store DB (system of record for the buyer) | SKU.io mirrors them and stamps its own order number back (`external_reference`). |
| Buyer portal (sign-in by email, order history, tracking) | Store | Magic links and sessions live in the store DB. |
| Emails (order confirmation, shipping) | Store, via a mail adapter | `sendgrid` or `console`. |
| Operations (stock, picking, shipping, accounting) | SKU.io | Through the Store API only. |

## Runtime

- **Storage:** one small driver interface (`Database`, D1's shape) over SQLite-family SQL.
  Schema in `packages/sdk/db/migrations/*.sql`.
  - **Cloudflare** (default): D1, binding `DB`, migrations applied with
    `wrangler d1 migrations apply <db>` (`--local` for dev).
  - **Node** (`STORE_HOST=node`): one SQLite file at `DATABASE_PATH` through
    `@skuio/storefront/db/sqlite` (`sqliteDatabase` over a better-sqlite3 handle),
    migrated on boot by `migrateSqlite`, which records what it applied in
    `_storefront_migrations`.
  The template picks one in `src/lib/host.<STORE_HOST>.ts`. Unit tests run every SQL path on
  the same SQLite driver.
- **Core:** `@skuio/storefront/store` — `createStore({ db, config, env, mail?, clock? })`
  returns the services: `catalog`, `inventory`, `checkout`, `orders` (incl. fulfilments),
  `customers`, `sessions`, `events`, `health()`. Framework-agnostic (no Astro, no DOM).
- **Store API:** `@skuio/storefront/api` — `handleStoreApi(request, { store, apiKey })`
  implements `/api/skuio/v1/*` as one handler the Astro route delegates to. Auth is the
  `STORE_API_KEY` secret (bearer, constant-time compare).
- **Payments:** `@skuio/storefront/payments` — `PaymentAdapter` interface;
  `@skuio/storefront/payments/stripe`, `@skuio/storefront/payments/manual`.
- **Mail:** `@skuio/storefront/mail` — `MailAdapter`; `sendgrid`, `console`.
- **Blocks** (Astro UI) in `registry/blocks/` read from the store through
  `src/lib/store.ts` (`store(Astro)` per request). Every page is server-rendered: the
  header needs the category tree, so nothing can be prerendered.

## Environment

| Name | Purpose |
|---|---|
| `STORE_HOST` (build time) | `cloudflare` (default) or `node`: the Astro adapter and the hosting seam. |
| `DB` (binding) | Cloudflare: the D1 database. |
| `DATABASE_PATH` | Node: the SQLite file (default `data/store.db`; keep it on a persistent volume). |
| `STORE_API_KEY` | Bearer key SKU.io uses to call the Store API. Generate with `openssl rand -hex 32`. |
| `PAYMENT_PROVIDER` | Comma list, in the order checkout offers them: `stripe`, `paypal`, `btcpay`, `manual`. Default `stripe` when `STRIPE_SECRET_KEY` exists, else `manual`. With more than one, the buyer picks at checkout and each processor's webhook is `/api/payments/webhook?provider=<id>`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe adapter only. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` | PayPal adapter (Orders v2) only. `PAYPAL_ENV=live` for production; sandbox otherwise. |
| `BTCPAY_URL`, `BTCPAY_STORE_ID`, `BTCPAY_API_KEY`, `BTCPAY_WEBHOOK_SECRET` | BTCPay adapter (Bitcoin on-chain + Lightning, Greenfield API) only. |
| `MAIL_PROVIDER`, `SENDGRID_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | Mail adapter: `sendgrid` or `console` (logs the whole message; readable in `wrangler tail`). |
| `SESSION_SECRET` | HMAC key for magic-link and session hashes (only hashes are stored). |
| `PUBLIC_SITE_URL` | Absolute origin for links in emails and processor return URLs. |
| `ORDER_NOTIFICATION_EMAIL`, `CONTACT_NOTIFICATION_EMAIL` | Optional merchant addresses for paid orders and contact-form messages. |

Local development on Cloudflare: `npm run db:migrate:local && npm run seed`, secrets in
`.dev.vars`, then `npm run dev` (the platform proxy provides the local D1). On Node:
`STORE_HOST=node DATABASE_PATH=data/store.db`, `npm run seed:sqlite`, secrets in the
environment (or `.env`), then `npm run dev`; production is `npm run build:node` and
`npm run start:node`.

## Order lifecycle

```
cart ─▶ /checkout/ (address, shipping method) ─▶ POST /api/checkout ─▶ order(pending_payment)
                                                                          │
                                        adapter.start(order) ─▶ processor (or instructions)
                                                                          │
   webhook ─▶ adapter.handleWebhook() ─┬─▶ order(paid) ─▶ confirmation email (+ merchant email)
   return  ─▶ adapter.verifyReturn()  ─┘
                                                       │
   SKU.io GET /orders (updated_since) ─▶ sales order in SKU.io ─▶ PATCH external_reference
   SKU.io ships ─▶ POST /orders/{id}/fulfillments ─▶ order(fulfilled) ─▶ shipping email
```

The store collects the address and shipping choice itself, so every adapter — including
`manual`, which has no hosted page — receives a complete order. Stripe is used in
payment-only mode: line items and the chosen shipping rate as fixed amounts,
`client_reference_id` = order id.

Statuses: `pending_payment → paid → processing → partially_fulfilled → fulfilled`, plus
`cancelled` and `refunded`. Payment status: `unpaid | paid | refunded | failed`.

**Abandoned checkouts.** A processor checkout (any adapter but `manual`) still
`pending_payment` 24 hours after creation is treated as abandoned:
`orders.expireAbandoned({ olderThanMinutes = 1440 })` moves it to `cancelled` with an
`abandoned` event and `cancelled_at`, leaving its lines intact. It runs lazily — at the
start of the Store API `GET /orders` and of `POST /api/checkout` (indexed on
`status, created_at`, so it is cheap) — and needs no cron. `manual` orders never expire.
A payment that the processor reports for an expired order still lands: `markPaid` reopens
the order as `paid` with an `uncancelled` event, so a paid order is never lost.

## Discount codes and partners

Codes live in `storefront.config.ts` (`discounts`), not at the processor. `/api/checkout`
validates the code and prices it into the order — `discount`, `discount_code` — so it works
under every payment adapter, and a code the buyer saw applied is never silently dropped (an
invalid one is a 422 on `discount_code`). Stripe receives the discount as a single-use coupon;
PayPal as `breakdown.discount`; BTCPay simply invoices the discounted total.

A code may name a `partner` and a `commissionPercent`. The order then stores the partner and
the commission owed **at the rate in force when it was placed** (`partner_commission`), so a
later rate change never rewrites history. `?code=X` on any page (`config.referral`) sets a
cookie that pre-applies the code at checkout. A partner sees their own orders — number, date,
country, amounts, never the buyer — at `/partners/<partner>/?key=<HMAC of the partner id under
SESSION_SECRET>`; rotating the secret revokes every link. The Store API exposes `discount_code`
only; partner and commission stay in the store.

## Why not pull orders from the processor

A processor only knows about money. It does not know the SKU, the customer's account, the
shipping choice or the fulfilment; and every processor is different. The store already
holds the complete order the moment it is created, so the operations system reads the
store. Payment reconciliation, when needed, stays inside the payment adapter.
