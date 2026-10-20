---
name: launch
description: Take a new store (no previous site) from preview to open for orders — the go-live checklist covering payments, email, catalogue facts, SKU.io, crawl surface and the first real order.
---

# Launch a new store

For a store replacing a live WooCommerce site, use `.claude/skills/cutover`
instead (it includes everything here plus the migration). Work top to bottom;
each item says how to prove it. Commands assume Cloudflare Workers, the
default host.

## Before the domain points at the store

1. **Preview first.** Deploy with `STORE_PREVIEW=1` and share that URL for
   review: banner on every page, `x-robots-tag: noindex`, robots.txt
   disallows everything, so the preview never competes with the real site
   in search.
2. **The processor will keep you.** Read the processor's restricted-business
   list and acceptable-use policy against the actual products (see
   `CLAUDE.md` → "Choosing a payment processor"). Note any new-account fund
   hold in the plan. Proof: the owner has read the relevant clause, or the
   processor confirmed in writing.
3. **Catalogue facts are sourced.** Every product's specs, photos and claims
   trace to the manufacturer or the owner; nothing left marked `CONFIRM`.
   Prices are integer cents and match the owner's list.
4. **Policies are real.** Shipping, returns, terms and privacy pages say what
   the business actually does (restocking fees, final-sale items, regions it
   ships to), and the shipping options in `storefront.config.ts` match the
   shipping page.
5. **Email delivers.** `MAIL_PROVIDER` is `cloudflare` or `sendgrid`, never
   `console`, and a sign-in link sent to a real inbox arrives with DKIM
   passing (`CLAUDE.md` → **Email**). Set `ORDER_NOTIFICATION_EMAIL` to
   someone who will act on it.
6. **Checkout is proven in test mode** for every method offered:
   `.claude/skills/verify-checkout` → "Against the live store".
7. **SKU.io is connected** and a test order arrives as a sales order with
   every line mapped; seed stock is gone (`.claude/skills/connect-skuio`).
8. **Measurement is in place.** Analytics and any ad pixels / server events
   are installed and verified with test event codes, so the first real
   purchase is counted.

## Go live

1. Production Worker: `STORE_PREVIEW` unset, live processor keys and the live
   webhook endpoint + secret, `PUBLIC_SITE_URL` and `CANONICAL_HOST` set to
   the real origin.
2. `node scripts/predeploy.mjs && npm run deploy`, then attach the custom
   domain (apex and www; the non-canonical one 301s via the middleware).
3. Register the live domain(s) for Apple Pay / wallets in the processor's
   **live** mode, if offered.
4. Wait about a minute for secrets to propagate, then run the deploy skill's
   **After every deploy** checks against the real domain.
5. **One real order.** Buy the cheapest product with a real card, watch the
   webhook mark it paid, the emails arrive, SKU.io create the sales order;
   then refund it and check the refund reaches the order.
6. Submit `https://<domain>/sitemap.xml` in Search Console (and Bing
   Webmaster Tools) and confirm robots.txt names it.

## The first week

- Watch `npx wrangler tail` (or the dashboard's logs) for 5xx after each deploy.
- Check every paid order in the store appears in SKU.io; investigate any that
  do not before the next one ships.
- Look at the site on a real iPhone, inside the Instagram/Facebook in-app
  browser too if the store advertises there.
