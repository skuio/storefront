import type { APIContext } from 'astro'
import { handleStoreApi } from '@skuio/storefront/api'
import { resolveImage } from '../../../../lib/images'
import { readEnv, siteUrl, store } from '../../../../lib/store'

export const prerender = false

/**
 * The Store API at its neutral path, /api/store/v1 — what any operations
 * system (an ERP, an OMS, a script) talks to; see docs/store-api.md in the kit.
 * The same handler also serves /api/skuio/v1 (src/pages/api/skuio/v1), the path
 * SKU.io's Storefront integration calls. Auth is a connection key issued
 * through /admin/connect, or the STORE_API_KEY secret as a break-glass.
 */
export function ALL(context: APIContext): Promise<Response> {
  const site = siteUrl(context)
  return handleStoreApi(context.request, {
    store: store(context),
    apiKey: readEnv(context, 'STORE_API_KEY'),
    // images[].url is the URL this site serves the image at (/_astro/<name>.<hash>.jpg), absolute.
    imageUrl: (src) => {
      const resolved = resolveImage({ src })
      return resolved ? new URL(resolved.src, `${site}/`).href : null
    },
  })
}
