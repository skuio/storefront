import type { Database } from '@skuio/storefront/store'

/**
 * Hosting seam — Cloudflare Workers (the default). `src/lib/store.ts` imports
 * `~host`, which astro.config.mjs points at `host.<STORE_HOST>.ts`. To run on
 * another host, build with `STORE_HOST=node` (see host.node.ts) or add a
 * `host.<name>.ts` exporting the same two functions.
 */
type Ctx = { locals: App.Locals }

/** The store database: the D1 binding named DB (wrangler.jsonc). */
export function database(ctx: Ctx): Database {
  const db = ctx.locals.runtime?.env?.DB
  if (!db) throw new Error('No D1 binding "DB". Add it to wrangler.jsonc and run `npm run db:migrate:local` (see README).')
  return db
}

/** Platform bindings and secrets for this request (Worker env; `.dev.vars` under `astro dev`). */
export function platformEnv(ctx: Ctx): Record<string, unknown> | undefined {
  return ctx.locals.runtime?.env as Record<string, unknown> | undefined
}
