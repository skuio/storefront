# My store

Built with the [SKU.io storefront kit](https://github.com/skuio/storefront):
Astro, Stripe Checkout, Cloudflare Workers.

```
npm install
cp .env.example .env    # add a Stripe test key
npm run dev             # http://localhost:4321
npm run e2e             # checkout guardrail
npm run deploy
```

Start with `CLAUDE.md` — it explains how the store is put together and what to
keep green. The catalogue is in `src/data/`; the look is in `src/styles/global.css`;
what happens when an order is paid is in `src/lib/orders.ts`.
