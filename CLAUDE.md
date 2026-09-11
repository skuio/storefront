# Working on the storefront kit

This is the monorepo for the SKU.io storefront kit. Read `README.md` for what
it is; this file is for changing it.

## Layout and the one rule about it

```
packages/sdk        @skuio/storefront — framework-agnostic; no Astro, no DOM
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
- **Stripe is an optional peer of the SDK**, imported only from
  `@skuio/storefront/stripe`. A store on another processor must not pull
  Stripe into its bundle.
- **The CLI has no runtime dependencies.** Node built-ins only.
- **Blocks assume two template files:** `src/lib/catalog.ts` exporting
  `catalog`, `config`, `routes`; `src/lib/images.ts` exporting `resolveImage`.
  Noted in `registry.json` → `conventions`. Do not add more assumptions
  without documenting them there.

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
npm run template:e2e        # STRIPE_SECRET_KEY in templates/default/.env for the live step
```

## Versioning

SDK and CLI are versioned together. Stores pin `@skuio/storefront` with a
caret range, so a breaking change to any exported type or to the block
conventions is a major bump. The registry is unversioned by design — stores
own their copies.
