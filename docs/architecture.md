# Architecture

## Why a kit and not a platform

Merchants pick a storefront first and an inventory system second, and the
storefront market is owned by players with fifteen-year moats in themes, apps
and conversion tooling. Competing there is a losing frame. What SKU.io can do
that a storefront platform structurally cannot is **run the store on the
inventory system's own data** — no sync, no oversells, no price drift — and
serve **several brands from one stock pool** with **B2B and B2C as one engine**.

The kit is the thin presentation layer that makes that possible without
becoming a platform. It ships one good reference store and the blocks it is
made of, and expects a coding agent to do the design.

## Three ways code is reused, and why each piece uses the one it does

| Mechanism | Used for | Why |
|---|---|---|
| npm dependency | `@skuio/storefront` (SDK) | API contract and checkout logic must update under every store without touching its design |
| copy-and-own | blocks, template | design must be the store's to bend; a fork would fight every merge |
| git fork | nothing | forks of a public repo cannot be private, and sites must be |

A store therefore has **no git relationship** to this repo. It depends on a
package and contains copies of files. `skuio add` refreshes a copy on request.

## The repos

```
skuio/storefront (public, MIT)      this repo — SDK, CLI, registry, template
<merchant>/<store> (private)        a site: depends on the SDK, owns its UI
sku.io (private)                    Storefront API, storefront token, hosted portal
```

## Providers

`CatalogProvider` is the seam. `jsonProvider` makes a store fully static and
is the top of the funnel — a store can be built, designed and deployed before
SKU.io is ever involved. `skuioProvider` is the upgrade: live stock, live
prices, orders into SKU.io, a customer portal. Same components, one config
line.

## What runs where

Every catalogue page is prerendered and served as static assets. The Worker
runs only for `src/pages/api/*` and the success page. Card data goes to
Stripe's hosted page and never touches the store. The buy form carries a SKU
and a quantity; the server prices it.

## The customer portal

Split in two:

- **Hosted by SKU.io** — auth, PII, order history, saved payment methods. Every
  merchant gets a secure account area on day one regardless of what their
  storefront looks like. This is the floor.
- **Blocks in this repo** — `/account/*` pages calling the customer API, so an
  agent can render accounts natively in the store's own design. This is the
  ceiling. `order-lookup` is the first of these and works today against
  Stripe alone.

## What SKU.io has to build

In order:

1. A **storefront token type** — scoped to one storefront: read catalogue,
   read availability (as in/low/out, not counts), create checkout. Never an
   admin PAT.
2. **Storefront API v1** — catalogue with visibility rules, live stock,
   customer-group pricing, checkout session creation, order webhook.
3. A **`storefront` sales channel type** — each tenant has N storefronts with a
   domain, token, catalogue subset, customer groups → price lists, and a
   processor. Modelling it as a channel gives order attribution and
   per-storefront reporting from existing machinery.
4. **Customer API + hosted portal.**

The kit is built so that (1)–(3) are a config flip for a store, not a
migration.
