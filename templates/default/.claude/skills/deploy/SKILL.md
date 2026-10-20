---
name: deploy
description: Create the database, apply the schema, set secrets, deploy this store (Cloudflare Workers by default) and check the live site afterwards. Refuses to ship with pending migrations or a stale linked SDK.
---

# Deploy

The steps below are for Cloudflare Workers + D1, the default host. On another
host the same order holds — schema first, then secrets, then code, then the
post-deploy checks — with that host's commands.

## First time

1. `npx wrangler login`
2. Set `name` in `wrangler.jsonc` to the Worker name you want.
3. Create the database and paste its id into `wrangler.jsonc` → `d1_databases[0].database_id`:
   ```
   npx wrangler d1 create <name>
   ```
4. Apply the schema and seed the catalogue:
   ```
   npm run db:migrate
   npm run seed:remote
   ```
   Seed data is demo data. Never seed a store that SKU.io will feed — see
   `.claude/skills/connect-skuio`.
5. Set secrets — each prompts for the value, nothing is written to disk:
   ```
   openssl rand -hex 32 | npx wrangler secret put STORE_API_KEY
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put PUBLIC_SITE_URL          # https://<your-domain>
   npx wrangler secret put CANONICAL_HOST           # optional: www.<domain> or <domain>
   npx wrangler secret put PAYMENT_PROVIDER         # stripe | paypal | manual | … (comma list)
   npx wrangler secret put STRIPE_SECRET_KEY        # stripe only
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # stripe only
   npx wrangler secret put MAIL_PROVIDER            # cloudflare | sendgrid | console
   npx wrangler secret put SENDGRID_API_KEY         # sendgrid only
   npx wrangler secret put MAIL_FROM                # an address on a verified domain / sender
   npx wrangler secret put ORDER_NOTIFICATION_EMAIL # optional
   npx wrangler secret put CONTACT_NOTIFICATION_EMAIL
   ```
   Email setup (Cloudflare Email Service binding, DKIM, coexisting with Google
   Workspace; SendGrid's 403) is in `CLAUDE.md` → **Email**.
6. Stripe only: add a webhook endpoint for `https://<your-domain>/api/payments/webhook`
   on `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed` and `charge.refunded`; its signing
   secret is `STRIPE_WEBHOOK_SECRET`.

For a shareable preview before launch, deploy a separate Worker with
`STORE_PREVIEW=1`: banner on every page, never indexed. Going live is
`.claude/skills/launch`.

## Every time

```
npm run e2e                     # guardrail
node scripts/predeploy.mjs      # rebuilds a linked SDK, checks its exports, refuses pending migrations
npm run db:migrate              # only when predeploy says the database is behind
npm run deploy                  # astro build && wrangler deploy
```

**Never deploy with pending migrations.** New code against an old schema fails
on every page that reads a new column: a staging store went 502 right after an
SDK bump because the deploy shipped before `db:migrate`. `predeploy.mjs`
compares the migrations the installed SDK ships with the remote database's
`d1_migrations` table and exits non-zero if any are missing. Migrate first;
the SDK's migrations are additive, so the old Worker keeps serving on the new
schema until the new one replaces it. `npm run deploy` runs it first on its own
(`predeploy` in `package.json`).

**A linked SDK must be rebuilt.** When `@skuio/storefront` is a `file:`
dependency or a workspace link, the store bundles the SDK's compiled `dist/`,
and nothing rebuilds it for you: a deploy once failed with `Rollup failed to
resolve import "@skuio/storefront/payments/paypal"` because the adapter was in
`src/` but not `dist/` on the machine that deployed. `predeploy.mjs` rebuilds a
linked SDK and asserts every export it declares exists.

If the global `CF_API_KEY` / `CF_API_EMAIL` environment variables are set on
your machine, D1 commands may fail with "Authentication error [code: 10000]";
run wrangler as `env -u CF_API_KEY -u CF_API_EMAIL npx wrangler …` so its own
login is used (`scripts/db-migrate.mjs` and `scripts/predeploy.mjs` already do this).

Two Cloudflare specifics the template already handles, so you know why they exist:
- `public/.assetsignore` lists `_worker.js` — without it wrangler refuses to deploy,
  because the server bundle would otherwise be uploaded as a public asset.
- `public/_redirects` may only use status 200/301/302/303/307/308. There is no
  410; let dead endpoints 404 from the Worker instead.

Then attach the custom domain to the Worker in the Cloudflare dashboard (or
`wrangler`), and confirm `public/_redirects` behaves on the live domain.

## After every deploy: check the live site

A green `wrangler deploy` proves the upload, not the store. Against the live
domain (`SITE=https://<your-domain>`):

1. **Pages render styled.** Open the home page and a product page in a fresh
   browser. `curl -sI $SITE/ | grep -i cache-control` must say `no-cache`; the
   middleware sets it on HTML so a browser never shows a page from the last
   deploy pointing at deleted `/_astro/*.css`. On Cloudflare Workers (the
   default host), an unstyled page after a deploy means something cached the
   HTML: purge the zone cache and look for a Cache Rule that caches HTML.
2. **The schema matches.** `node scripts/predeploy.mjs --skip-build` reports
   every migration applied; any 5xx in `npx wrangler tail` mentioning
   `no such column` / `no such table` means a migration was skipped.
3. **Secrets took.** A secret set seconds ago may not be everywhere yet. Wait
   about a minute after any `secret put`, then exercise what uses it (a
   checkout reaches the processor, a sign-in email arrives, `/health` answers
   with the new `STORE_API_KEY`).
4. **The Store API answers.**
   `curl -H "Authorization: Bearer $KEY" $SITE/api/skuio/v1/health` → 200;
   without the header → 401.
5. **Crawl surface.** `curl $SITE/robots.txt` names `Sitemap: $SITE/sitemap.xml`
   and that URL returns XML; a production store must **not** return
   `x-robots-tag: noindex` (that is `STORE_PREVIEW=1`, previews only).
6. **Canonical host.** If `CANONICAL_HOST` is set, `curl -sI` the other host
   and expect `301` to the same path on the canonical one.
7. **Checkout.** Walk `.claude/skills/verify-checkout` → "Against the live
   store" when the deploy touched checkout, payments, `src/lib/` or the config.
