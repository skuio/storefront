# @skuio/storefront

Typed catalogue, checkout and order primitives for storefronts on the SKU.io
storefront kit. Framework-agnostic: takes and returns plain data.

```ts
import { Catalog, defineStorefront, jsonProvider, formatMoney } from '@skuio/storefront'
import { createStripeCheckout, parseStripeWebhook } from '@skuio/storefront/stripe'
```

- `Catalog` — load once, query synchronously: products by SKU/slug, a category
  tree with paths and distinct product counts, breadcrumbs, deep membership.
- `defineStorefront` / `defineRoutes` — configurable URL patterns so a migrated
  store keeps every legacy URL.
- `Money` is integer minor units everywhere; there is no float price.
- `jsonProvider` (committed JSON, fully static) and `skuioProvider` (the SKU.io
  Storefront API: live availability, checkout created by SKU.io on the
  tenant\'s processor, orders born in SKU.io).
- Stripe helpers behind a separate entry point so non-Stripe stores never
  bundle it. Prices are only ever read from the catalogue on the server.
- Cart functions — pure, browser-agnostic, never trusted for money.

Start a store with `npx @skuio/cli create my-store`. Kit and docs:
https://github.com/skuio/storefront
