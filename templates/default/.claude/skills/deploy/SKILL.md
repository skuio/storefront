---
name: deploy
description: Create the D1 database, apply the schema, set secrets, and deploy this store to Cloudflare Workers.
---

# Deploy

First time:
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
5. Set secrets — each prompts for the value, nothing is written to disk:
   ```
   openssl rand -hex 32 | npx wrangler secret put STORE_API_KEY
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   npx wrangler secret put PUBLIC_SITE_URL          # https://<your-domain>
   npx wrangler secret put PAYMENT_PROVIDER         # stripe | manual
   npx wrangler secret put STRIPE_SECRET_KEY        # stripe only
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # stripe only
   npx wrangler secret put MAIL_PROVIDER            # sendgrid | console
   npx wrangler secret put SENDGRID_API_KEY         # sendgrid only
   npx wrangler secret put MAIL_FROM                # verified sender
   npx wrangler secret put ORDER_NOTIFICATION_EMAIL # optional
   npx wrangler secret put CONTACT_NOTIFICATION_EMAIL
   ```
6. Stripe only: add a webhook endpoint for `https://<your-domain>/api/payments/webhook`
   on `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed` and `charge.refunded`; its signing
   secret is `STRIPE_WEBHOOK_SECRET`.

Every time:
```
npm run e2e       # guardrail
npm run db:migrate  # only after upgrading @skuio/storefront with a new migration
npm run deploy    # astro build && wrangler deploy
```

If the global `CF_API_KEY` / `CF_API_EMAIL` environment variables are set on
your machine, D1 commands may fail with "Authentication error [code: 10000]";
run wrangler as `env -u CF_API_KEY -u CF_API_EMAIL npx wrangler …` so its own
login is used (`scripts/db-migrate.mjs` already does this).

Two Cloudflare specifics the template already handles, so you know why they exist:
- `public/.assetsignore` lists `_worker.js` — without it wrangler refuses to deploy,
  because the server bundle would otherwise be uploaded as a public asset.
- `public/_redirects` may only use status 200/301/302/303/307/308. There is no
  410; let dead endpoints 404 from the Worker instead.

Then attach the custom domain to the Worker in the Cloudflare dashboard (or
`wrangler`), and confirm `public/_redirects` behaves on the live domain.
