# Working on the storefront kit

This is the monorepo for the SKU.io storefront kit. Read `README.md` for what
it is; this file is for changing it.

## Layout and the one rule about it

```
packages/sdk        @skuio/storefront — store core, Store API, adapters; framework-agnostic; no Astro, no DOM
packages/cli        @skuio/cli — node only, zero runtime deps
registry/blocks     UI blocks (Astro) — SOURCE OF TRUTH for store components
templates/default   the reference store — BUILT FROM the registry
scripts/            sync-template.mjs and friends
docs/               architecture and decisions
```

**Edit blocks in `registry/blocks/`, then `npm run sync:template`.** Never
edit a block file under `templates/default/src/components` or
`templates/default/src/pages/api` directly — the sync will overwrite it and CI
fails on drift (`node scripts/sync-template.mjs --check`). Files that exist
only in the template (pages, layout, config, styles, data) are edited in place.

## Boundaries

- **The SDK knows nothing about Astro.** It takes and returns plain data.
  Image resolution, `import.meta.glob`, components — all template-side.
- **The SDK never holds a float price.** `Money.amount` is integer minor
  units. Tests enforce this; keep them.
- **Stripe is an optional peer of the SDK.** `@skuio/storefront/payments/stripe`
  only imports its types and takes a client from the caller; nothing else in
  the SDK mentions it. A store on another processor writes its own
  `PaymentAdapter` and drops the import from `src/lib/store.ts`.
- **The store core never talks to a processor or an operations system.**
  Processors come in through `PaymentAdapter`; SKU.io comes in through the
  Store API (`docs/store-api.md`). Keep both seams thin.
- **D1 semantics.** Bind values are string | number | null (never undefined
  or boolean); `first()`/`all()` only on statements that return rows;
  anything atomic goes through `batch()`. Tests run the same SQL on
  better-sqlite3 behind the same interface, through the driver Node hosts use
  (`packages/sdk/src/db/sqlite.ts`).
- **The CLI has no runtime dependencies.** Node built-ins only.
- **Blocks assume two template files:** `src/lib/store.ts` exporting `store`,
  `config`, `routes`, `readEnv`, `payment`, `paymentContext`, `mail`, `siteUrl`;
  `src/lib/images.ts` exporting `resolveImage`. Noted in `registry.json` →
  `conventions`. Do not add more assumptions without documenting them there.
- **Blocks use colour tokens, never literal colours.** `ink`, `body`, `shell`,
  `rule`, `accent`, `accent-dark`, `on-accent`, `page`, `panel`, `panel-2` from
  the template's `global.css`. No `bg-white`, `text-white` on an accent or ink
  fill, or hex values: a dark-themed store must be able to
  take a block unchanged. Status colours (green "Shipped" badges) are the one exception.
- **No host is assumed.** The template reaches the platform only through
  `src/lib/host.<STORE_HOST>.ts` (`database`, `platformEnv`), picked by
  `STORE_HOST` in `astro.config.mjs`: `cloudflare` (D1) or `node` (SQLite file).
  Blocks never read `locals.runtime` for anything they need; `waitUntil` is
  used only when present. Keep both hosts green: CI runs the guardrail on each.
- **Every page is server-rendered.** The header needs the category tree from
  the database, so no page can be prerendered; `<Image>` from `astro:assets` has
  no runtime transformer on Cloudflare — blocks use `<img>` with `resolveImage`.

## Adding a block

1. Create `registry/blocks/<name>/` with the files.
2. Add an entry to `registry/registry.json`: `name`, `description`, `files`
   (`from` relative to the block dir, `to` relative to a store root),
   `dependencies` (npm), `registryDependencies` (other blocks it imports).
3. `npm run sync:template`, use it somewhere in the template, `npm run template:build`.
4. If it touches checkout, extend `templates/default/e2e/checkout.spec.ts`.

## Verifying

```
npm run build && npm test && npm run check
node scripts/sync-template.mjs --check
npm run template:build
npm run template:e2e        # needs the template's local D1: cd templates/default && npm run db:migrate:local && npm run seed
```

## Versioning

SDK and CLI are versioned together. Stores pin `@skuio/storefront` with a
caret range, so a breaking change to any exported type or to the block
conventions is a major bump. The registry is unversioned by design — stores
own their copies.
