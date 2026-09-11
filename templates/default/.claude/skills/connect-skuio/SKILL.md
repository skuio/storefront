---
name: connect-skuio
description: Switch this store from the committed JSON catalogue to the live SKU.io catalogue, and route paid orders into SKU.io.
---

# Connect to SKU.io

> The SKU.io Storefront API is not live yet. `skuioProvider` throws a clear
> error until it ships. These steps describe the intended flow so the site is
> ready to flip.

## Catalogue

1. In SKU.io, create a Storefront for this site and copy its storefront token.
   This token is read-only on the catalogue and can create checkouts — it is
   not an admin personal access token, and an admin token must never be used
   here.
2. In `storefront.config.ts`, replace `jsonProvider({...})` with:
   ```ts
   skuioProvider({
     tenant: 'https://<tenant>.sku.io',
     storefrontId: '<id>',
     storefrontToken: import.meta.env.SKUIO_STOREFRONT_TOKEN,
   })
   ```
3. Add `SKUIO_STOREFRONT_TOKEN` to `.env` locally and as a Worker secret.
4. Delete `src/data/` and the JSON imports. Product images still come from
   `src/assets/products/` unless the provider supplies URLs.
5. `npm run build` — every page should regenerate from live data.

## Orders

Extend `onOrderCompleted` in `src/lib/orders.ts` to create a sales order in
SKU.io. Key the write on `order.processorSessionId` so a retried webhook does
not create a second order.
