import Stripe from 'stripe'
import type { APIContext } from 'astro'

/**
 * Secrets come from the Worker binding in production and from .env during
 * `astro dev`. Reading both keeps one code path for local work and deploys.
 */
export function readEnv(context: APIContext, key: string): string | undefined {
  const runtimeEnv = (context.locals as { runtime?: { env?: Record<string, unknown> } }).runtime?.env
  const fromRuntime = runtimeEnv?.[key]
  if (typeof fromRuntime === 'string' && fromRuntime) return fromRuntime
  const fromDotEnv = (import.meta.env as Record<string, unknown>)[key]
  if (typeof fromDotEnv === 'string' && fromDotEnv) return fromDotEnv
  return undefined
}

export function getStripe(context: APIContext): Stripe | null {
  const secretKey = readEnv(context, 'STRIPE_SECRET_KEY')
  if (!secretKey) return null
  return new Stripe(secretKey, {
    // Workers have no Node http stack; the fetch client is required.
    httpClient: Stripe.createFetchHttpClient(),
  })
}
