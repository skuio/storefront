---
name: verify-checkout
description: Prove the store still works end to end after a change — catalog from D1, checkout, order lifecycle through the Store API.
---

# Verify checkout

```
npm run db:migrate:local && npm run seed   # once
npm run e2e
```

What it checks (against the dev server on the local D1, `manual` payments):
- the home page links into the catalog and those links resolve
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

## Against the live store, and with real processors

The e2e runs `manual` payments only. Before launch and after any payment
change, walk each offered method in a browser — sandbox / test mode first,
then one small real purchase you refund. Things that have wasted hours:

- **PayPal's sandbox popup needs a headed, real browser.** In a headless
  browser the PayPal window opens blank or never completes the login. Run the
  browser headed (real Chrome) and log in with a sandbox *personal* account
  from the PayPal developer dashboard, not the business one.
- **Stripe Link's "save my info" box can block Pay.** On Stripe Checkout, the
  Link sign-up checkbox opens a phone field that is then required; untick it
  (or fill it) before concluding the Pay button is broken.
- **Apple Pay needs the domain registered, per mode and per host.** Register
  each domain the button appears on (apex *and* www, the preview host) in the
  processor's dashboard, separately for test and live mode. An unregistered
  domain hides the button silently; it does not error.
- **Ad-platform server events only with a test event code.** When checking a
  purchase event sent server-side (Meta Conversions API, TikTok Events API,
  Google Ads), send it with the platform's test event code and look in its
  test-events view. A test without it once posted a real purchase into a live
  ad account, which then optimised against a fake sale.
- **Express buttons:** on a phone-width viewport, wallet buttons sit above
  the form, their space is reserved before they load (no jump), and a wallet
  that is unavailable on this device leaves no empty gap.
- **iOS:** run the purchase once on a real iPhone (or WebKit). Taps arrive as
  `pointerType: "mouse"` and `mailto:` is dead in in-app browsers — see
  `CLAUDE.md` → "Mobile, iOS and in-app browsers".
- After a processor key or webhook secret changes, wait about a minute before
  testing: secrets take a moment to propagate.
