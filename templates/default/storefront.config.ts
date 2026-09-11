import { defineStorefront, flatRate, freeShipping, jsonProvider, type Category, type Product } from '@skuio/storefront'
import products from './src/data/products.json'
import categories from './src/data/categories.json'

/**
 * The one file that describes this store.
 *
 * `provider` is where the catalogue comes from. jsonProvider reads the two
 * files above and needs no backend. When the store is connected to SKU.io,
 * swap it for skuioProvider({...}) and delete src/data — nothing else changes.
 *
 * `routes` are URL patterns. If you change them, move the files under
 * src/pages to match (they are just files; Astro routes by filename).
 */
export default defineStorefront({
  name: 'Northwind Outfitters',
  url: 'https://www.example.com',
  currency: 'usd',
  locale: 'en-US',

  provider: jsonProvider({
    products: products as Product[],
    categories: categories as Category[],
  }),

  routes: {
    product: '/products/:slug/',
    category: '/collections/:path/',
    shop: '/shop/',
  },

  shipping: [
    freeShipping('us-standard', 'Free shipping (United States)', { min: 3, max: 7 }),
    flatRate('intl', 'International shipping', { amount: 2500, currency: 'usd' }, { min: 7, max: 21 }),
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
})
