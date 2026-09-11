// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import storefront from './storefront.config'

// Every catalogue page is prerendered and served from Cloudflare's asset store.
// The Worker only runs for routes that opt out with `export const prerender = false`:
// the checkout endpoint, the webhook, the success page, and the form handlers.
export default defineConfig({
  site: storefront.url,
  output: 'server',
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [sitemap({ filter: (page) => !page.includes('/api/') && !page.includes('/checkout/') })],
  vite: { plugins: [tailwindcss()] },
})
