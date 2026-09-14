// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'
import storefront from './storefront.config'

// Catalogue pages, checkout, the portal and the Store API render in the
// Worker per request from the D1 database. Only routes that say
// `export const prerender = true` (policy pages, the cart shell) are static.
// In `astro dev` the Cloudflare platform proxy provides the local D1 and
// reads secrets from .dev.vars.
export default defineConfig({
  site: storefront.url,
  output: 'server',
  adapter: cloudflare({ imageService: 'compile', platformProxy: { enabled: true, persist: true } }),
  vite: { plugins: [tailwindcss()] },
})
