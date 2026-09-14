---
name: verify-checkout
description: Prove the store still works end to end after a change — catalogue from D1, checkout, order lifecycle through the Store API.
---

# Verify checkout

```
npm run db:migrate:local && npm run seed   # once
npm run e2e
```

What it checks (against the dev server on the local D1, `manual` payments):
- the home page links into the catalogue and those links resolve
- a product page has a buy form carrying a SKU and **no price field**, and no `/_image?` URL
- `/api/checkout` returns 422 with per-field details for an unknown SKU and missing fields
- an order goes cart → `/checkout/` → `/checkout/pending/`, is read back through
  `GET /api/skuio/v1/orders/{id}`, marked paid with `PATCH`, shipped with
  `POST …/fulfillments` (201, then 200 on redelivery), and the confirmation
  page shows it fulfilled; guest lookup returns the tracking number
- the Store API returns 401 without or with a wrong key

To exercise Stripe as well, set `PAYMENT_PROVIDER=stripe` and a **test-mode**
`STRIPE_SECRET_KEY` in `.dev.vars`, place an order in the browser with card
4242 4242 4242 4242, and forward the webhook with `stripe listen --forward-to
localhost:4321/api/payments/webhook` (its `whsec_…` goes in `STRIPE_WEBHOOK_SECRET`).
Never run this against a live key.

Against a deployed Worker, a bare `curl -X POST /api/checkout` with form data
returns 403 by design (CSRF origin check). Send JSON, or add
`-H "Origin: https://<your-domain>"` to reproduce what a browser sends.

If it fails after your change, the likely culprits in order: `BuyButton.astro`
lost its hidden `sku` input or no longer points at `/checkout/`; the checkout
page's field names changed without `src/pages/api/checkout.ts`;
`storefront.config.ts` changed `routes` without the page files moving; the
local database was never migrated or seeded.
