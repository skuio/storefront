---
name: connect-skuio
description: Connect this store to SKU.io as a Storefront sales channel — SKU.io pulls orders and pushes inventory, tracking and products through the Store API.
---

# Connect to SKU.io

The store is the system of record for the buyer; SKU.io is the operations
system. They meet at the **Store API** (`/api/skuio/v1/*`, contract in the
kit's `docs/store-api.md`). Nothing about the store's design changes.

## Steps

1. Generate the key and set it as a Worker secret (nothing is printed or committed):
   ```
   openssl rand -hex 32 | npx wrangler secret put STORE_API_KEY
   ```
   For local development put the same or another value in `.dev.vars`.

2. Check the API answers from the outside:
   ```
   curl -H "Authorization: Bearer $KEY" https://<your-domain>/api/skuio/v1/health
   ```
   `200` with `data.counts`; `401` without the header.

3. In SKU.io: Integrations → add **Storefront** → enter the site URL and the
   key → **Test connection** (it calls `/health`). Then choose what SKU.io
   owns: orders (polled from `GET /orders?updated_since`), inventory
   (`PUT /inventory`), fulfilments (`POST /orders/{id}/fulfillments`), and
   optionally the catalogue (`PUT /products`, `PUT /categories`).

4. If SKU.io owns the catalogue, `src/data/*.json` becomes history: keep it
   or delete it. Product images pushed by SKU.io are URLs; `resolveImage`
   uses them as-is (keep `src/assets/products/` only for local copies).

## What SKU.io does with the contract

- Every paid order appears as a sales order on the storefront channel; SKU.io
  stamps its number back with `PATCH /orders/{id}` (`external_reference`).
- Stock pushed with `PUT /inventory` drives availability: `available <= 0` is
  sold out (or backorder when allowed), at or under `lowStockThreshold` shows
  "only N left".
- A shipment pushed with `POST /orders/{id}/fulfillments` moves the order to
  partially/fully fulfilled and emails the buyer tracking once.
- A `manual` order is marked paid with `PATCH /orders/{id}` `payment.status = paid`.

## Before you switch it on

- **Seed and demo stock never reaches production.** `npm run seed:remote`
  writes the demo catalogue and its stock; a store SKU.io will feed must not
  carry it. If the production database was ever seeded, delete those products
  (or let SKU.io's first `PUT /products` replace them) and confirm
  `/health` → `data.counts` matches what SKU.io pushed before taking orders.
  A demo SKU with demo stock is an order nobody can fulfil.
- **Dropship and supplier-held stock must be pushed.** If the products ship
  from a supplier rather than your own warehouse, SKU.io only knows what the
  supplier feed tells it; set up the supplier's stock in SKU.io so `PUT
  /inventory` carries real numbers. Otherwise every product reads as sold
  out (or, with backorders allowed, oversells).
- **Confirm the product mapping after connecting.** Open a few products in
  SKU.io's storefront channel and check each listing is linked to the right
  SKU.io product (same SKU string as the store). An unmapped listing means its
  orders arrive with lines SKU.io cannot allocate, and its stock never syncs.
  Place one test order and watch it land as a sales order with every line
  matched.
- **Replacing a WooCommerce store cuts its order feed.** If SKU.io already
  pulls this business's orders from WooCommerce, retiring WooCommerce stops
  that feed. Connect the Storefront channel and see a test order arrive
  *before* the old site stops taking orders, then disable the WooCommerce
  channel so stock is not pushed twice. See `.claude/skills/cutover`.
