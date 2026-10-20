---
name: cutover
description: Move a live WooCommerce store onto this storefront without losing orders, rankings or revenue — audit the old store's configuration, protect what earns, migrate catalogue and URLs, keep the SKU.io order feed unbroken, then switch DNS.
---

# Cut over from WooCommerce

A cutover replaces a site that is already taking orders, ranking and feeding
ads. The rule: **nothing that earns today stops earning on cutover day.**
Everything in `.claude/skills/launch` applies too; this skill adds what a
migration needs. Commands assume Cloudflare Workers, the default host.

## 1. Audit the old store's configuration — write it down

Before building anything, capture how the live store actually behaves, in a
file in this repo (e.g. `docs/woocommerce-config.md`). Read it from the
WooCommerce REST API or the admin, not from memory. For each item record the
live value, what this store will do, and every deliberate difference:

- **Shipping zones and methods** — every zone, its regions and rates. Look
  for data-entry bugs: a state picked where a country was meant (e.g. the US
  state `US:GA` for the country Georgia, `GE`) quietly charges the wrong
  buyers. Do not reproduce a bug; record it and decide.
- **Tax** — is it calculated at all, where, with what store address.
- **Payment gateways** — which are enabled, which processor accounts they use,
  and whether those accounts carry over (keys, webhooks, disputes history).
- **Returns, refunds and final-sale rules** — the returns page *and* any
  product descriptions that contradict it. Reconcile them with the owner and
  the supplier's actual terms before copying either.
- **Order profile** — typical lines per order, countries, order values; it
  decides whether the cart, express checkout or international shipping matter.
- **Catalogue quirks** — product types (simple/variable), SKUs with HTML
  entities, products whose permalink names a category they are not in.

Open questions go to the owner as decisions, recorded in the same file.

## 2. Find what earns, and protect it

Before touching URLs or templates, list every source of revenue and traffic
(`CLAUDE.md` → "SEO migrations"):

- Shopping feeds (Merchant Center) — the new catalogue must produce the same
  item ids/links, or the feed must be regenerated and resubmitted on the day.
- Ad-platform purchase tags and conversion events — they must fire from the
  new success page before cutover, verified with test event codes.
- Top landing pages from Search Console and analytics — each keeps its URL
  or gets a 301.
- Affiliate / partner links and coupon codes in circulation.

## 3. Migrate catalogue and URLs

```
npm run migrate:woocommerce -- --origin https://old-site.com
npm run migrate:images
npm run seed            # local; seed:remote only for a store SKU.io will not feed
```

- Set `routes` in `storefront.config.ts` to the old URL shape so product and
  category URLs do not move; everything else gets a line in
  `public/_redirects`. Check every old URL from the sitemap and the top
  landing pages answers 200 or a single 301 on the new site.
- Category descriptions are migrated as HTML and rendered on category pages;
  confirm they show (a heading plus a grid does not get indexed).
- Product facts and photos come across as they were; fix contradictions found
  in step 1 with the owner, never by guessing.

## 4. Keep the order feed unbroken

If SKU.io already pulls this store's orders through a WooCommerce channel,
**retiring WooCommerce cuts that feed**. Connect this store as a Storefront
channel (`.claude/skills/connect-skuio`) on the staging host, prove a test
order arrives mapped, and plan the switch so no order is taken by either site
without reaching SKU.io. After cutover, disable the WooCommerce channel so
inventory is not pushed to two places.

## 5. Cutover day

1. Freeze catalogue edits on the old site; re-export if anything changed.
2. Production Worker with live keys, `PUBLIC_SITE_URL` and `CANONICAL_HOST`
   matching the old canonical host (www or apex — keep whichever ranked).
3. `node scripts/predeploy.mjs && npm run deploy`; attach the domain; lower
   the DNS TTL beforehand so a rollback is fast.
4. Run the deploy skill's **After every deploy** checks, then one real order
   (refund it) end to end into SKU.io.
5. Resubmit the sitemap and the shopping feed; confirm the purchase tag fired
   in the ad platform.
6. Keep the old origin reachable (not public) for a few weeks: orders in
   flight, refunds, and anything the export missed.

## 6. The fortnight after

Watch Search Console coverage and 404s, ad conversions against the previous
fortnight, and every order reaching SKU.io. A drop in any of them is a
cutover bug until proven otherwise.
