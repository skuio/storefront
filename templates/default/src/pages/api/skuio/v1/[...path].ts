import type { APIContext } from 'astro'
import { handleStoreApi } from '@skuio/storefront/api'
import { resolveImage } from '../../../../lib/images'
import { paymentMethods, readEnv, siteUrl, store } from '../../../../lib/store'

export const prerender = false

/**
 * The Store API — what SKU.io (or any operations system) talks to. One
 * handler covers every method and path under /api/skuio/v1; see
 * docs/store-api.md in the kit. Auth is a connection key issued through
 * /admin/connect, or the STORE_API_KEY secret as a break-glass.
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
    // GET /orders/{id} asks the processor that took a paid order for its fee when the store has not recorded it yet.
    payments: () => paymentMethods(context),
  })
}
