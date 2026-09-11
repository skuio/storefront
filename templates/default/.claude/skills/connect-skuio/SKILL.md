---
name: connect-skuio
description: Switch this store from the committed JSON catalogue to the live SKU.io catalogue, with checkout and orders handled by SKU.io.
---

# Connect to SKU.io

> Status: the provider is implemented and tested against the v1 contract
> (`docs/storefront-api.md` in the kit). The endpoints are being added to
> SKU.io. Until they ship, `skuioProvider` calls fail with a `SkuioApiError`
> from the tenant — never silently with an empty catalogue.

## What changes when you connect

| | `jsonProvider` (today) | `skuioProvider` |
|---|---|---|
| Catalogue | `src/data/*.json` | live from SKU.io at build time |
| Availability | `available` in the JSON | live status: in stock / low / out / backorder / preorder |
| Checkout | this store creates a Stripe session | **SKU.io creates it** on the tenant's processor |
| Stripe key on the store | required | **not needed** — remove it |
| Orders | your `src/lib/orders.ts` | born in SKU.io on the storefront channel; `orders.ts` optional |

## Steps

1. In SKU.io, create a **Storefront** for this site and copy its **storefront
   token** (`sf_live_…` / `sf_test_…`). It can read the catalogue and create
   checkouts, nothing else. Never use an admin personal access token here —
   the provider refuses one before making a request, and the API rejects it.

2. `storefront.config.ts` — replace the provider:
   ```ts
   import { skuioProvider } from '@skuio/storefront'

   provider: skuioProvider({
     tenant: 'https://<tenant>.sku.io',
     storefrontToken: import.meta.env.SKUIO_STOREFRONT_TOKEN,
   }),
   ```
   Keep `routes`, `shipping` and `contact` — routes and contact still drive
   this store; shipping options come from SKU.io at checkout but the values
   here still feed the product-page copy.

3. Secrets: add `SKUIO_STOREFRONT_TOKEN` to `.env` and as a Worker secret.
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` can be removed — the
   checkout endpoint prefers the provider and never calls Stripe when one is
   present.

4. Delete `src/data/` and the two JSON imports. Product images: SKU.io
   returns URLs; keep `src/assets/products/` only if you want local copies
   (`resolveImage` matches by filename either way).

5. `npm run build` — every page regenerates from live data — then
   `npm run e2e`. The checkout test asserts the redirect goes to a hosted
   checkout page; with the provider it is SKU.io's, not Stripe's.

## Orders

Completed checkouts become sales orders in SKU.io on this storefront's channel
with no code on your side. If you also want something to happen here (an
email, a Slack ping), register a storefront webhook in SKU.io pointing at
`/api/skuio-webhook` and extend `src/lib/orders.ts` — see the contract's
"Storefront webhooks" section.
