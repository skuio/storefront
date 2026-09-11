---
name: verify-checkout
description: Prove the checkout still works end to end after a change — structural checks always, a live Stripe test-mode session when a key is present.
---

# Verify checkout

```
npm run e2e
```

What it checks:
- the home page links into the catalogue
- a product page has a buy form carrying a SKU and **no price field**
- `/api/checkout` returns 400 for an unknown SKU
- with `STRIPE_SECRET_KEY` in `.env`: a POST creates a real Stripe session,
  and the session's `unit_amount` equals the catalogue price

If the last test is skipped, add a Stripe **test-mode** key to `.env` and rerun.
Never run this against a live key.

Against a deployed Worker, a bare `curl -X POST /api/checkout` returns 403 by
design (CSRF origin check). Add `-H "Origin: https://<your-domain>"` to reproduce
what a browser sends.

If it fails after your change, the likely culprits in order: `BuyButton.astro`
lost its hidden `sku` input; `src/pages/api/checkout.ts` no longer redirects
with 303; `storefront.config.ts` changed `routes` without the page files moving.
