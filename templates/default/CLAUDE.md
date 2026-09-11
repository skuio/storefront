# This store — how it is put together

You are working on a storefront built from the SKU.io storefront kit. This file
tells you how it fits together, what is safe to change freely, and the one
thing that must stay green.

## The shape

```
storefront.config.ts       the store: name, URL, currency, catalogue provider, routes, shipping
src/lib/catalog.ts         loads the catalogue once; exports { catalog, config, routes }
src/lib/images.ts          resolves a product image to its file in src/assets/products
src/lib/stripe.ts          Stripe client + readEnv (Worker binding or .env)
src/lib/email.ts           SendGrid
src/lib/orders.ts          what happens when an order is paid  <-- the integration seam
src/lib/cart.client.ts     browser cart (localStorage); client-only, import from <script> only
src/components/            UI blocks — copied from the registry, now owned by this project
src/pages/                 routes; Astro routes by filename
src/pages/api/             the only code that runs on the server (checkout, webhook, forms)
src/data/*.json            the catalogue, when using the json provider
src/assets/products/       product images, matched to products by filename
src/styles/global.css      design tokens; change these and everything follows
e2e/checkout.spec.ts       the guardrail
```

Everything under `src/pages` is prerendered at build time except files that say
`export const prerender = false` — those run in the Cloudflare Worker per request.

## Rules

1. **Keep `npm run e2e` green.** It proves the checkout still works: product page
   has a buy form, the endpoint refuses unknown SKUs, and (with a Stripe test key)
   a real session is created at the catalogue price. Run it after any change to
   `src/pages/api/`, `src/lib/`, `storefront.config.ts` or `BuyButton.astro`.

2. **Prices never come from the browser.** `/api/checkout` receives a SKU and a
   quantity and looks the price up in the catalogue. Do not add a price, amount,
   or total field to any form. Do not read one from a request.

3. **The webhook is the order, not the success page.** A customer can close the
   tab before `/checkout/success/` loads. Anything that must happen when an order
   is paid belongs in `src/lib/orders.ts`, called from the webhook. It must be
   idempotent: Stripe retries, so key any external write on
   `order.processorSessionId`.

4. **A header-less POST to `/api/*` gets a 403 — that is correct.** Astro's
   `security.checkOrigin` rejects POSTs whose `Origin` does not match the site.
   Browsers always send it on a same-origin form post; `curl` does not. Do not
   disable it. Test with `-H "Origin: <site>"` or through the browser.

5. **Secrets are Worker secrets.** Never write a key into a committed file.
   Locally they live in `.env` (gitignored); in production `wrangler secret put`.
   Read them with `readEnv(context, 'NAME')`, never `process.env`.

6. **No `<Image>` in the layout, header, or footer — use `<img src={asset.src}>`.**
   Those render on `/checkout/success/`, which is server-rendered per request.
   The build-time (`compile`) image service has no runtime transformer, so an
   `<Image>` there emits `/_image?…` and returns 522 in production. `<Image>` is
   fine on any prerendered page (products, collections, static pages). The e2e
   asserts the success page contains no `/_image?` URL.

7. **`src/lib/catalog.ts` must keep exporting `catalog`, `config`, `routes`**, and
   `src/lib/images.ts` must keep exporting `resolveImage`. Registry blocks import
   those names.

## Common tasks

**Change the look.** Edit the tokens in `src/styles/global.css` first — colours,
fonts, the `display-heading` utility. Most of a restyle is done there. Then
touch components.

**Add a page.** Create `src/pages/<name>.astro`, wrap it in `BaseLayout`, add
`export const prerender = true`. Link it from `SiteHeader`/`SiteFooter` if it
belongs in navigation. See `.claude/skills/add-page`.

**Add a block from the registry.** `npx @skuio/cli add <name>` copies it into
`src/components`. `npx @skuio/cli list` shows what exists. Once copied the file
is yours. See `.claude/skills/add-block`.

**Change URLs.** Edit `routes` in `storefront.config.ts`, then move the files
under `src/pages` to match (`products/[slug].astro`, `collections/[...path].astro`).
Links use `routes.product()` / `routes.category()` so they follow the config.

**Edit the catalogue.** With the json provider, `src/data/products.json` and
`categories.json` are the source of truth. Prices are integer cents. Every
`images[].src` must match a filename in `src/assets/products/`. Product `sku`
and `slug` must be unique — the build fails otherwise.

**Migrate from WooCommerce.** `npm run migrate:woocommerce -- --origin https://old-site.com`
reads the public Store API into `src/data/`, then `npm run migrate:images`
pulls the pictures. Every product keeps its `legacyPath`; set `routes` in
`storefront.config.ts` to the old URL shape (or add lines to `public/_redirects`)
so nothing indexed moves. Variable products are flagged: the kit has no
variants yet.

**Connect to SKU.io.** Swap `jsonProvider(...)` for `skuioProvider(...)` in
`storefront.config.ts`. See `.claude/skills/connect-skuio`. (The Storefront API
is not live yet; the provider throws a clear error until it is.)

**The cart.** `AddToCartButton` snapshots name/price into localStorage;
`/cart/` renders from that and posts `items` (SKUs + quantities only) to
`/api/checkout`, which re-prices everything from the catalogue. The snapshot is
never trusted for money. `CartBadge` sits in the header's `end` slot. A store
that wants Buy-Now only can delete these three files and the slot content.

**Shipping regions.** Give a shipping option `countries: ['US']` and checkout
becomes region-enforced: the default session takes only those addresses and
rates; a second submit on the buy button (and a checkbox on the cart) opens a
session for everywhere else with only the other rates. Leave `countries` off
every option for a single region. Stripe Checkout cannot filter rates by
country by itself — this is how the store stops an international customer
picking the domestic rate.

**Do something when an order is paid.** Extend `onOrderCompleted` in
`src/lib/orders.ts`. It receives a processor-neutral `StorefrontOrder`.

**Deploy.** `npm run deploy`. See `.claude/skills/deploy`.

## Verifying your work

```
npm run check      # types
npm run build      # every page, every image
npm run e2e        # the checkout guardrail
```

A change is done when all three pass.
