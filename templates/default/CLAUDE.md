# This store — how it is put together

You are working on a storefront built from the SKU.io storefront kit. This file
tells you how it fits together, what is safe to change freely, and the one
thing that must stay green.

## The shape

```
storefront.config.ts       the store: name, URL, currency, routes, shipping, contact, thresholds
wrangler.jsonc             the Worker and its D1 database binding (DB)
src/lib/store.ts           store(Astro) per request; config, routes, readEnv, payment(), mail()  <-- the seams
src/lib/images.ts          resolves a product image to a local asset in src/assets/products or a URL
src/lib/account.ts         the portal's session cookie
src/lib/cart.client.ts     browser cart (localStorage); client-only, import from <script> only
src/components/            UI blocks — copied from the registry, now owned by this project
src/pages/                 routes; Astro routes by filename; every page renders in the Worker
src/pages/checkout/        the store's own checkout, success and pending pages
src/pages/api/checkout.ts  creates the order, hands it to the payment adapter
src/pages/api/payments/    the processor webhook (adapter-neutral)
src/pages/api/skuio/v1/    the Store API — what SKU.io talks to
src/pages/account/         portal: sign-in by emailed link, orders, order detail
src/data/*.json            a catalogue to seed the database from (npm run seed)
src/assets/products/       product images, matched to products by filename
src/styles/global.css      design tokens; change these and everything follows
scripts/db-migrate.mjs     applies the SDK's schema to D1 (local or remote)
scripts/seed-store.mjs     seeds D1 from src/data
e2e/checkout.spec.ts       the guardrail
```

Everything under `src/pages` is server-rendered per request in the Cloudflare
Worker, reading the D1 database through `store(Astro)`. There are no
prerendered pages: the header needs the live category tree.

## Rules

1. **Keep `npm run e2e` green.** It proves the store still works end to end:
   the catalogue renders from D1, a product page has a buy form, `/api/checkout`
   refuses unknown SKUs and reports missing fields, an order goes
   checkout → pending → paid → shipped through the Store API, and the Store
   API refuses a bad key. Run it after any change to `src/pages/api/`,
   `src/pages/checkout/`, `src/lib/`, `storefront.config.ts` or `BuyButton.astro`.
   It needs the local database: `npm run db:migrate:local && npm run seed` once.

2. **Prices never come from the browser.** The buy form and the cart send SKUs
   and quantities; `store.checkout.createOrder` prices every line from the
   database. Do not add a price, amount, or total field to any form. Do not
   read one from a request.

3. **The webhook is the payment, not the success page.** A buyer can close the
   tab before `/checkout/success/` loads. The order is created before payment
   starts; `src/pages/api/payments/webhook.ts` is what marks it paid. Every
   store method is idempotent, so a redelivered event is harmless. The success
   page also asks the adapter's `verifyReturn` so it is right when the webhook
   is late.

4. **A header-less POST to `/api/*` form endpoints gets a 403 — that is
   correct.** Astro's `security.checkOrigin` rejects form POSTs whose `Origin`
   does not match the site. JSON requests (the Store API, the webhook) are not
   affected. Test forms with `-H "Origin: <site>"` or through the browser.

5. **Secrets are Worker secrets.** Never write a key into a committed file.
   Locally they live in `.dev.vars` (gitignored, see `.dev.vars.example`); in
   production `wrangler secret put`. Read them with `readEnv(context, 'NAME')`.

6. **No `<Image>` from `astro:assets` anywhere.** Pages are server-rendered and
   the `compile` image service has no runtime transformer: an `<Image>` emits
   `/_image?…` and fails in production. Use `<img>` with `resolveImage()`. The
   e2e asserts no `/_image?` URL on a product page.

7. **`src/lib/store.ts` must keep exporting `store`, `config`, `routes`,
   `readEnv`, `payment`, `paymentMethods`, `paymentContext`, `mail`, `siteUrl`**, and
   `src/lib/images.ts` must keep exporting `resolveImage`. Registry blocks
   import those names.

8. **The Store API is the contract with SKU.io.** Do not change its paths,
   payloads or status codes (`docs/store-api.md` in the kit); the handler
   lives in the SDK and the route only delegates to it.

## Common tasks

**Change the look.** Edit the tokens in `src/styles/global.css` first — colours,
fonts, the `display-heading` utility. Most of a restyle is done there. Then
touch components.

**Add a page.** Create `src/pages/<name>.astro`, wrap it in `BaseLayout`, add
`export const prerender = false`. Link it from `SiteHeader`/`SiteFooter` if it
belongs in navigation, and add its path to `STATIC` in `src/pages/sitemap.xml.ts`.
See `.claude/skills/add-page`.

**Add a block from the registry.** `npx @skuio/cli add <name>` copies it into
the project. `npx @skuio/cli list` shows what exists. Once copied the file is
yours. See `.claude/skills/add-block`.

**Change URLs.** Edit `routes` in `storefront.config.ts`, then move the files
under `src/pages` to match (`products/[slug].astro`, `collections/[...path].astro`).
Links use `routes.product()` / `routes.category()` so they follow the config.

**Edit the catalogue.** `src/data/products.json` and `categories.json` seed the
database (`npm run seed` locally, `npm run seed:remote` in production; upserts,
safe to re-run). Prices are integer cents. Every `images[].src` is a filename
in `src/assets/products/` or an absolute URL. Once SKU.io owns the catalogue it
pushes products, categories and stock through the Store API and the JSON is
just history.

**Migrate from WooCommerce.** `npm run migrate:woocommerce -- --origin https://old-site.com`
reads the public Store API into `src/data/`, then `npm run migrate:images`
pulls the pictures, then `npm run seed`. Every product keeps its `legacyPath`;
set `routes` in `storefront.config.ts` to the old URL shape (or add lines to
`public/_redirects`) so nothing indexed moves.

**Connect to SKU.io.** Generate `STORE_API_KEY`, set it as a Worker secret, and
add this store as a **Storefront** sales channel in SKU.io with the site URL
and the key. See `.claude/skills/connect-skuio`.

**Payments.** `PAYMENT_PROVIDER=stripe` needs `STRIPE_SECRET_KEY` and a webhook
endpoint at `/api/payments/webhook` (`STRIPE_WEBHOOK_SECRET`). `manual` needs
nothing: the order waits on `/checkout/pending/` until SKU.io marks it paid.
Another processor is a `PaymentAdapter` in `src/lib/store.ts`.

**Email.** `MAIL_PROVIDER=sendgrid` with `SENDGRID_API_KEY` and a verified
`MAIL_FROM`; otherwise `console`, which logs every message (magic links
included — read them with `wrangler tail`). Templates live in the SDK.

**The cart.** `AddToCartButton` snapshots name/price into localStorage;
`/cart/` renders from that and links to `/checkout/`, which posts SKUs and
quantities only. `CartBadge` sits in the header's `end` slot.

**Shipping regions.** Give a shipping option `countries: ['US']` and the
checkout offers only that option to those countries and only the unscoped
options to everyone else — enforced on the server, not just in the form.

**The customer portal.** `/account/` emails a single-use sign-in link to any
address that has ordered; the session is a hashed token in D1 behind one
httpOnly cookie (`src/lib/account.ts`). `/account/orders/` lists history with
tracking and can reorder into the cart; `/account/orders/<id>/` is the detail.
`/account/order-lookup/` works without signing in (order number + email).

**Do something when an order is paid.** The store already emails the buyer
and `ORDER_NOTIFICATION_EMAIL`. For anything else, SKU.io sees the order on
its next poll of `GET /api/skuio/v1/orders`; for store-side effects, extend
`src/pages/api/payments/webhook.ts` after `applyPaymentEvents`.

**Deploy.** `npm run db:migrate` once per schema change, `npm run deploy`.
See `.claude/skills/deploy`.

## Verifying your work

```
npm run check      # types
npm run build      # the Worker bundle
npm run e2e        # the guardrail (local D1 + dev server)
```

A change is done when all three pass.
