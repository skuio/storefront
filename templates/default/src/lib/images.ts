import type { ProductImage } from '@skuio/storefront'

/**
 * Product images live in src/assets/products, imported eagerly so Astro emits
 * them as hashed static assets. A product's `images[].src` is matched to a
 * file by basename, so a catalog exported from anywhere still resolves to
 * the local copy; an absolute URL (a product pushed by SKU.io with hosted
 * images) is used as-is.
 *
 * Pages are server-rendered, so blocks use a plain <img> with these values —
 * never <Image> from astro:assets, which has no runtime transformer here.
 */
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/products/*.{jpg,jpeg,png,webp,avif,svg}',
  { eager: true }
)

const byBasename = new Map<string, ImageMetadata>(
  Object.entries(modules).map(([path, mod]) => [path.split('/').pop()!, mod.default])
)

export interface ResolvedImage {
  src: string
  width?: number
  height?: number
}

export function resolveImage(image?: ProductImage | { src: string } | null): ResolvedImage | null {
  if (!image?.src) return null
  const basename = decodeURIComponent(image.src.split('?')[0]!.split('/').pop() ?? '')
  const local = byBasename.get(basename)
  if (local) return { src: local.src, width: local.width, height: local.height }
  if (/^https?:\/\//.test(image.src)) return { src: image.src }
  return null
}
