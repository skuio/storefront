# Architecture

## Why a platform of our own, and why it is not tied to a processor

Merchants pick a storefront first and an inventory system second, and the
storefront market is owned by players with fifteen-year moats in themes, apps
and conversion tooling. Competing there head-on is a losing frame. What SKU.io
can do that a storefront platform structurally cannot is **run operations on
the store's real orders and push the truth back** — stock, tracking, products —
through one small contract, for any number of stores, with **B2B and B2C as
one engine**.

So the kit is a **self-contained e-commerce platform** (think WooCommerce
without WordPress): an Astro site with its own SQL database (D1 on Cloudflare
Workers by default, or SQLite on any Node host)
database that owns catalog, customers, orders, payments and the buyer
portal, plus a **Store API** the operations system talks to. Payments and mail
are adapters. Nothing in the platform depends on Stripe, on SKU.io, or on any
other vendor; each is a plug.

The earlier design (v1) pulled orders out of the payment processor. That is
the wrong system of record: a processor only knows about money, every
processor is different, and it knows nothing about the SKU, the customer's
account, the shipping choice or the fulfilment. The store already holds the
complete order the moment it is created, so the operations system reads the
store. See `store-platform.md`.

## Three ways code is reused, and why each piece uses the one it does

| Mechanism | Used for | Why |
|---|---|---|
| npm dependency | `@skuio/storefront` (SDK: store core, Store API, adapters) | contract and order logic must update under every store without touching its design |
| copy-and-own | blocks, template | design must be the store's to bend; a fork would fight every merge |
| git fork | nothing | forks of a public repo cannot be private, and sites must be |

A store therefore has **no git relationship** to this repo. It depends on a
package and contains copies of files. `skuio add` refreshes a copy on request.

## The repos

```
skuio/storefront (public, MIT)      this repo — SDK, CLI, registry, template
<merchant>/<store> (private)        a site: depends on the SDK, owns its UI and its database
sku.io (private)                    the "Storefront" sales-channel integration: a Store API client
```

## What runs where

Every page is **server-rendered per request from the store's database** — the header alone
needs the category tree, so nothing can be prerendered — and one catalog
snapshot is shared by every component in a request (cached briefly per
isolate). Static assets (images, CSS, JS) are served by the assets binding.
Card data goes to the processor's hosted page and never touches the store.
The buy form carries a SKU and a quantity; the server prices it from the
database.

## Payments

`PaymentAdapter` is the seam: `start(order)` takes a complete, priced,
addressed order and returns a redirect or instructions; `handleWebhook`
decodes what the processor reports; `verifyReturn` covers the buyer coming
back before the webhook lands; the optional `settlement(order)` asks the
processor what it captured and kept (its fee), which the Store API uses to fill
in `payment.fee` on `GET /orders/{id}` when the confirmation did not carry it. `stripe` (hosted Checkout in payment-only
mode) and `manual` (pay later, marked paid by the operations system) ship;
`manual` is the proof that the pipeline needs no processor at all.

## The buyer portal

Lives in the store. Sign-in is an emailed single-use link (`sessions`), the
session is a hashed token in the store's database behind one httpOnly cookie, and order history
with fulfilments and tracking reads the store's own tables. Guest lookup by
order number + email works without an account.

## What SKU.io builds

A **Storefront** sales-channel integration that is a client of the Store API:
poll `GET /orders?updated_since=…` into sales orders, stamp `external_reference`,
push stock with `PUT /inventory`, push shipments with
`POST /orders/{id}/fulfillments`, and optionally own the catalog with
`PUT /products` / `PUT /categories`. The contract is `store-api.md` +
`api/store-api-v1.openapi.yaml`.
