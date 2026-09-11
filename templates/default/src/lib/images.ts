import type { ProductImage } from '@skuio/storefront'

/**
 * Product images live in src/assets/products so Astro can optimise them at
 * build time. A product's `images[].src` is matched to a file by basename, so
 * the catalogue can carry the original URL from wherever it was exported and
 * still resolve to the local copy.
 */
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/products/*.{jpg,jpeg,png,webp,avif,svg}',
  { eager: true }
)

const byBasename = new Map<string, ImageMetadata>(
  Object.entries(modules).map(([path, mod]) => [path.split('/').pop()!, mod.default])
)

export function resolveImage(image?: ProductImage): ImageMetadata | null {
  if (!image) return null
  const basename = decodeURIComponent(image.src.split('?')[0]!.split('/').pop() ?? '')
  return byBasename.get(basename) ?? null
}
