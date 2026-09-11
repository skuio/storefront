import type { Category, Product } from '../src/types.js'

export const categories: Category[] = [
  { id: 'toyota', name: 'Toyota', slug: 'toyota', parentId: null },
  { id: 'toyota-tacoma', name: 'Tacoma 95-04', slug: 'tacoma-95-04', parentId: 'toyota' },
  { id: 'toyota-supra', name: 'Supra 93-02', slug: 'supra-93-02', parentId: 'toyota' },
  { id: 'honda', name: 'Honda', slug: 'honda', parentId: null },
  { id: 'honda-civic', name: 'Civic 06-11', slug: 'civic-06-11', parentId: 'honda' },
  { id: 'empty', name: 'Empty', slug: 'empty', parentId: null },
]

export const products: Product[] = [
  {
    id: '1',
    sku: 'VDCTOYTAC9504',
    name: 'Toyota Tacoma 1995-2004',
    slug: 'toyota-tacoma-1995-2004',
    price: { amount: 109900, currency: 'usd' },
    compareAtPrice: { amount: 129500, currency: 'usd' },
    categoryIds: ['toyota-tacoma'],
    images: [{ src: '/img/tacoma.jpg' }],
    available: true,
  },
  {
    id: '2',
    sku: 'VDCTOYSUP9302',
    name: 'Toyota Supra 1993-2002',
    slug: 'toyota-supra-1993-2002',
    price: { amount: 119900, currency: 'usd' },
    categoryIds: ['toyota-supra'],
    images: [],
    available: true,
  },
  {
    id: '3',
    sku: 'VDCHCIV0611',
    name: 'Honda Civic 2006-2011',
    slug: 'honda-civic-2006-2011',
    price: { amount: 99500, currency: 'usd' },
    categoryIds: ['honda-civic'],
    images: [],
    available: false,
  },
]
