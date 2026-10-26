import type { AstroCookies } from 'astro'
import type { StoreQuote } from '@skuio/storefront'
import type { Store } from '@skuio/storefront/store'
import { readSession } from './account'

/**
 * Who may see a quote: the buyer holding its emailed access key (a guest needs nothing else), or the signed-in
 * customer it belongs to. Anything else is a 404, never a hint that the quote exists.
 */
export async function quoteForViewer(store: Store, cookies: AstroCookies, id: string, key: string | null): Promise<StoreQuote | null> {
  if (key) {
    const byKey = await store.quotes.getWithKey(id, key)
    if (byKey) return byKey
  }
  const customer = await store.sessions.resolve(readSession(cookies))
  return customer ? store.quotes.getForCustomer(id, customer.id) : null
}

/** The page a buyer is sent to after a quote action; the key keeps a guest on it without signing in. */
export function quotePath(quote: Pick<StoreQuote, 'id' | 'accessKey'>, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ key: quote.accessKey, ...params })
  return `/quotes/${encodeURIComponent(quote.id)}/?${query}`
}
