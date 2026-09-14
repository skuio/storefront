import type { APIContext } from 'astro'
import { handleStoreApi } from '@skuio/storefront/api'
import { readEnv, store } from '../../../../lib/store'

export const prerender = false

/**
 * The Store API — what SKU.io (or any operations system) talks to. One
 * handler covers every method and path under /api/skuio/v1; see
 * docs/store-api.md in the kit. Auth is the STORE_API_KEY secret.
 */
export function ALL(context: APIContext): Promise<Response> {
  return handleStoreApi(context.request, { store: store(context), apiKey: readEnv(context, 'STORE_API_KEY') })
}
