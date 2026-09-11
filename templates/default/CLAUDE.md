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

4. **Secrets are Worker secrets.** Never write a key into a committed file.
   Locally they live in `.env` (gitignored); in production `wrangler secret put`.
   Read them with `readEnv(context, 'NAME')`, never `process.env`.

5. **`src/lib/catalog.ts` must keep exporting `catalog`, `config`, `routes`**, and
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

**Connect to SKU.io.** Swap `jsonProvider(...)` for `skuioProvider(...)` in
`storefront.config.ts`. See `.claude/skills/connect-skuio`. (The Storefront API
is not live yet; the provider throws a clear error until it is.)

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
