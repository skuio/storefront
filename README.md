# SKU.io storefront kit

Build a fast, headless storefront on Astro + Stripe Checkout, with your
catalogue from committed JSON today and from SKU.io when you connect it. Deploys
to Cloudflare Workers. Designed to be built and extended by coding agents.

```
npx @skuio/cli create my-store
cd my-store && npm install
cp .env.example .env          # add a Stripe test key
npm run dev
```

Then open `CLAUDE.md` in the new store. It explains the shape of the project
to whatever agent you point at it, and names the one test that has to stay green.

## What's in here

| Path | What | Published as |
|---|---|---|
| `packages/sdk` | Catalogue types and queries, URL routing, money, Stripe checkout + webhook helpers. Framework-agnostic. | `@skuio/storefront` |
| `packages/cli` | `create` a store from a template, `add` blocks from the registry. | `@skuio/cli` |
| `registry/` | UI blocks: source of truth for everything under a store's `src/components` and `src/pages/api`. | copied into stores by `skuio add` |
| `templates/default` | The reference store. Built from the registry; a complete, deployable site with a demo catalogue. | copied by `skuio create` |

## The model: SDK as a dependency, UI as owned code

A store created with the CLI is a plain project. It **depends on**
`@skuio/storefront` from npm, so API and checkout logic update with
`npm update`. It **owns** every component and page outright — they were copied
in, and they are the store's to redesign. `skuio add <block>` pulls a fresh copy
of a block when you want one; it never overwrites without being asked.

There is no theme system. The reference template is one good store, and the
blocks are the pieces it is made of. Give an agent `CLAUDE.md` and a brief and
it will build the design; the SDK, the checkout and the guardrail test stay
underneath.

## Providers

`storefront.config.ts` names a catalogue provider:

- **`jsonProvider`** — reads `src/data/products.json` and `categories.json`.
  No backend, no credentials. A store on this provider is fully static and
  runs anywhere. This is what the template ships with.
- **`skuioProvider`** — reads the live SKU.io Storefront API: real stock,
  real prices, and orders flowing back into SKU.io. *Not yet live* — the
  Storefront API is being added to SKU.io. The provider throws a clear error
  until it ships, so nothing fails silently.

Switching is one line in the config. Nothing that renders the catalogue knows
which it is talking to.

## Security model

- The buy form posts a **SKU and a quantity, and no price**. `/api/checkout`
  looks the price up on the server and builds the Stripe session from that.
- Card data never touches the store: Stripe's hosted page collects it.
- The only server code is under `src/pages/api` plus the success page. Every
  catalogue page is prerendered.
- Secrets are Worker secrets, read through `readEnv`; nothing is committed.
- When connected to SKU.io, the store holds a **storefront-scoped token** —
  read catalogue, create checkout — never an admin token.

## Developing the kit

```
npm install
npm run build              # sdk + cli
npm test                   # sdk unit tests
npm run sync:template      # registry -> templates/default
npm run template:build
npm run template:e2e       # needs STRIPE_SECRET_KEY in templates/default/.env
```

Edit blocks under `registry/blocks/`, never directly in the template — CI runs
`sync-template --check` and fails on drift. See `CLAUDE.md`.

## Status

Early. The SDK, CLI, registry and template work end to end against Stripe
test mode with the JSON provider. The SKU.io provider is a stub pending the
Storefront API. Not yet on npm.

MIT.
