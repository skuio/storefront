# My store

Built with the [SKU.io storefront kit](https://github.com/skuio/storefront): Astro
and the `@skuio/storefront` store core, with checkout, orders, buyer portal and a
Store API in the store's own database.

## Run it on Cloudflare Workers + D1 (default)

```
npm install
npx wrangler d1 create my-store            # paste the id into wrangler.jsonc
npm run db:migrate:local && npm run seed   # schema + demo catalog
cp .dev.vars.example .dev.vars             # manual payments + console mail need no keys
npm run dev                                # http://localhost:4321
npm run e2e                                # the checkout guardrail
npm run deploy
```

## Run it on any Node host

```
npm install
export STORE_HOST=node DATABASE_PATH=data/store.db
npm run seed:sqlite                        # schema + demo catalog into the SQLite file
npm run dev                                # http://localhost:4321
npm run build:node && npm run start:node   # production: node dist/server/entry.mjs (PORT, HOST)
```

Secrets come from the environment on Node (`STORE_API_KEY`, `SESSION_SECRET`,
`PAYMENT_PROVIDER`, ...; see `.dev.vars.example`). Keep `DATABASE_PATH` on a
persistent volume. The host-specific code is all in `src/lib/host.<STORE_HOST>.ts`.

Start with `CLAUDE.md`: it explains how the store is put together and what to
keep green. The catalog is in `src/data/`, the look is in `src/styles/global.css`,
and the store's wiring is in `src/lib/store.ts`.
