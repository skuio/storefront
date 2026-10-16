# SKU.io storefront kit

A self-contained e-commerce platform for coding agents to build stores on:
Astro on Cloudflare Workers with its own D1 database, a store core that owns
catalogue, checkout, orders, payments and the buyer portal, and a **Store
API** so an operations system (SKU.io first) can pull orders and push
inventory, fulfilments and products. Payments and mail are adapters. Think
WooCommerce without WordPress, and without being tied to any processor.

```
npx @skuio/cli create my-store
cd my-store && npm install
npx wrangler d1 create my-store           # paste the id into wrangler.jsonc
npm run db:migrate:local && npm run seed  # schema + demo catalogue into the local D1
cp .dev.vars.example .dev.vars            # manual payments + console mail work with no keys
npm run dev
```

Then open `CLAUDE.md` in the new store. It explains the shape of the project
to whatever agent you point at it, and names the one test that has to stay green.

## What's in here

| Path | What | Published as |
|---|---|---|
| `packages/sdk` | The store core (`/store`), the Store API handler (`/api`), payment adapters (`/payments`, `/payments/stripe`, `/payments/paypal`, `/payments/btcpay`, `/payments/manual`), mail adapters (`/mail`, `/mail/sendgrid`, `/mail/console`), the D1 schema (`db/migrations`), and the catalogue/routing/money/cart primitives (`.`). Framework-agnostic. | `@skuio/storefront` |
| `packages/cli` | `create` a store from a template, `add` blocks from the registry. | `@skuio/cli` |
| `registry/` | UI blocks: source of truth for everything under a store's `src/components` and `src/pages/api`. | copied into stores by `skuio add` |
| `templates/default` | The reference store. Built from the registry; a complete, deployable site with a demo catalogue. | copied by `skuio create` |
| `docs/` | `store-platform.md` (architecture, runtime, env), `store-api.md` + `api/store-api-v1.openapi.yaml` (the contract). | |

## The model: SDK as a dependency, UI as owned code

A store created with the CLI is a plain project. It **depends on**
`@skuio/storefront` from npm, so the store core, the Store API and the
adapters update with `npm update`. It **owns** every component and page
outright — they were copied in, and they are the store's to redesign.
`skuio add <block>` pulls a fresh copy of a block when you want one; it never
overwrites without being asked.

There is no theme system. The reference template is one good store, and the
blocks are the pieces it is made of. Give an agent `CLAUDE.md` and a brief and
it will build the design; the store core, the checkout and the guardrail test
stay underneath.

## How a store works

- **Catalogue** lives in the store's D1 database. Seed it from `src/data/*.json`
  with `npm run seed`, or let SKU.io push it through `PUT /products` and
  `PUT /categories`. Availability comes from `PUT /inventory`.
- **Checkout** is the store's own page: contact, address, shipping method.
  `POST /api/checkout` creates the order (priced from the database) and hands
  it to the payment adapter — Stripe hosted Checkout in payment-only mode,
  PayPal (Orders v2), BTCPay Server (Bitcoin / Lightning), or `manual` (pay
  later). A store can offer several; the buyer picks at checkout.
- **Discount codes** are the store's own (`discounts` in the config), priced
  into the order under any processor. A code can attribute sales to a
  partner, with the commission snapshotted on the order and a private
  partner report at `/partners/<partner>/`. The processor's webhook marks the order paid; the
  buyer gets a confirmation email.
- **Orders** are the system of record for the buyer. SKU.io reads them with
  `GET /orders?updated_since=…`, stamps its own number back, and pushes
  shipments; the store emails tracking.
- **Portal**: sign-in by emailed link, order history with tracking, reorder.
  Guest lookup by order number + email.

## Security model

- The buy form and the cart carry **SKUs and quantities, and no price**.
  `/api/checkout` prices every line from the database.
- Card data never touches the store: the processor's hosted page collects it.
- The Store API is a bearer secret (`STORE_API_KEY`) compared in constant time;
  the order's buyer-facing access key never leaves the store.
- Sessions and magic links are stored as HMAC hashes (`SESSION_SECRET`).
- Secrets are Worker secrets, read through `readEnv`; nothing is committed.

## Developing the kit

```
npm install
npm run build              # sdk + cli
npm test                   # sdk unit tests (SQLite behind the D1 driver interface)
npm run check              # types, every workspace
npm run sync:template      # registry -> templates/default (--check in CI)
npm run template:build
npm run template:e2e       # local D1: cd templates/default && npm run db:migrate:local && npm run seed
```

Edit blocks under `registry/blocks/`, never directly in the template — CI runs
`sync-template --check` and fails on drift. See `CLAUDE.md`.

## Status

v2. The store core, Store API, both adapters, the template and the e2e loop
(order → paid → shipped through the Store API) work end to end; the first
real store runs on it on Cloudflare Workers. Not yet on npm.

MIT.
