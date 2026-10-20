// @ts-check
import { defineConfig } from 'astro/config'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import storefront from './storefront.config'

// Where the store runs. STORE_HOST picks the Astro adapter and the hosting seam
// (`~host` → src/lib/host.<STORE_HOST>.ts) — the only host-specific code:
//   cloudflare (default) — a Worker with a D1 binding; `astro dev` gets the local
//                          D1 and .dev.vars through the platform proxy.
//   node                 — any Node server; one SQLite file at DATABASE_PATH,
//                          secrets from the environment. `node dist/server/entry.mjs`.
// Catalogue pages, checkout, the portal and the Store API render per request
// from the database. Only routes that say `export const prerender = true`
// (policy pages, the cart shell) are static.
const host = process.env.STORE_HOST ?? 'cloudflare'
if (!['cloudflare', 'node'].includes(host)) throw new Error(`STORE_HOST must be cloudflare or node, not ${host}`)
const adapter =
  host === 'node'
    ? (await import('@astrojs/node')).default({ mode: 'standalone' })
    : (await import('@astrojs/cloudflare')).default({ imageService: 'compile', platformProxy: { enabled: true, persist: true } })

export default defineConfig({
  site: storefront.url,
  output: 'server',
  // The Store API is bearer-authenticated machine traffic with no Origin header;
  // Astro's browser CSRF check would 403 its bodyless DELETEs. Browser form
  // handlers guard themselves with sameOrigin() from the SDK instead.
  security: { checkOrigin: false },
  adapter,
  vite: {
    plugins: [tailwindcss()],
    resolve: { alias: { '~host': fileURLToPath(new URL(`./src/lib/host.${host}.ts`, import.meta.url)) } },
    // On Node, load the SDK and the native SQLite module from node_modules at
    // runtime (the SDK reads its schema migrations from its package). A Worker
    // must be one bundle, so nothing is external there.
    ssr: host === 'node' ? { external: ['better-sqlite3', '@skuio/storefront'] } : {},
  },
})
