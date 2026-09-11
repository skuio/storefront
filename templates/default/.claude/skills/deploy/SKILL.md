---
name: deploy
description: Build and deploy this store to Cloudflare Workers, and set its secrets.
---

# Deploy

First time:
1. `npx wrangler login`
2. Set `name` in `wrangler.jsonc` to the Worker name you want.
3. Set secrets — each prompts for the value, nothing is written to disk:
   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put SENDGRID_API_KEY
   npx wrangler secret put MAIL_FROM
   npx wrangler secret put ORDER_NOTIFICATION_EMAIL
   npx wrangler secret put CONTACT_NOTIFICATION_EMAIL
   ```
4. In Stripe, add a webhook endpoint for `https://<your-domain>/api/stripe-webhook`
   on the event `checkout.session.completed`; its signing secret is
   `STRIPE_WEBHOOK_SECRET`.

Every time:
```
npm run e2e       # guardrail
npm run deploy    # astro build && wrangler deploy
```

Two Cloudflare specifics the template already handles, so you know why they exist:
- `public/.assetsignore` lists `_worker.js` — without it wrangler refuses to deploy,
  because the server bundle would otherwise be uploaded as a public asset.
- `public/_redirects` may only use status 200/301/302/303/307/308. There is no
  410; let dead endpoints 404 from the Worker instead.

Then attach the custom domain to the Worker in the Cloudflare dashboard (or
`wrangler`), and confirm `public/_redirects` behaves on the live domain.
