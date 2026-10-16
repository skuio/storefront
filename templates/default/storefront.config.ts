import { defineStorefront, flatRate, freeShipping } from '@skuio/storefront'

/**
 * The one file that describes this store.
 *
 * The catalogue itself lives in the store's database (Cloudflare D1): seed it
 * from src/data/*.json with `npm run seed`, or let SKU.io push it through the
 * Store API. Nothing here changes when the catalogue does.
 *
 * `routes` are URL patterns. If you change them, move the files under
 * src/pages to match (they are just files; Astro routes by filename).
 */
export default defineStorefront({
  name: 'Northwind Outfitters',
  url: 'https://www.example.com',
  currency: 'usd',
  locale: 'en-US',

  routes: {
    product: '/products/:slug/',
    category: '/collections/:path/',
    shop: '/shop/',
  },

  // Naming countries on a rate scopes it: those countries see only the scoped
  // rates, every other ship-to country sees the rest. Leave `countries` off
  // every option for one set of rates everywhere.
  shipping: [
    freeShipping('us-standard', 'Free shipping (United States)', { estimate: { min: 3, max: 7 }, countries: ['US'] }),
    flatRate('intl', 'International shipping', { amount: 2500, currency: 'usd' }, { estimate: { min: 7, max: 21 } }),
  ],
  shipToCountries: ['US', 'CA', 'GB', 'AU'],

  contact: {
    phone: '(555) 010-0100',
    phoneE164: '+15550100100',
    email: 'hello@example.com',
  },

  checkout: {
    maxQuantity: 10,
    allowPromotionCodes: true,
    collectPhone: true,
  },

  // Codes the store prices itself; a `partner` gets attributed sales and traffic. Share a partner
  // link as https://your-store/?code=WELCOME10 — it applies the code and counts the visit.
  discounts: [{ code: 'WELCOME10', percentOff: 10, partner: 'demo-partner', commissionPercent: 10 }],
  // Partners by id: `name` is what the welcome banner greets visitors with (the show), `contact`
  // the person the dashboard greets, and `email` signs in to the dashboard at /partners/. A partner with no email uses the key link from /admin/partners/.
  partners: [{ id: 'demo-partner', name: 'Demo Podcast', contact: 'Dana Host', email: 'partner@example.com' }],

  inventory: {
    // Stock at or below this shows "only N left". Only SKUs SKU.io tracks are affected.
    lowStockThreshold: 3,
  },
})
