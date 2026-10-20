import { paypalExpress, type PayPalExpress } from '@skuio/storefront/payments/paypal'
import { paymentMethods, readEnv } from './store'

type StoreContext = Parameters<typeof paymentMethods>[0]

/**
 * PayPal express (PayPal / Venmo / Pay Later buttons next to the buy button): the buyer starts in
 * PayPal and the address comes from their account. Null unless the store offers PayPal
 * (`PAYMENT_PROVIDER` includes `paypal`) and has its keys. The client id is public — it goes in the
 * PayPal JS SDK URL; the secret never leaves the server.
 */
export function paypalExpressSetup(ctx: StoreContext): { client: PayPalExpress; clientId: string } | null {
  const offered = paymentMethods(ctx).some((m) => m.id === 'paypal')
  const clientId = readEnv(ctx, 'PAYPAL_CLIENT_ID')
  const clientSecret = readEnv(ctx, 'PAYPAL_CLIENT_SECRET')
  if (!offered || !clientId || !clientSecret) return null
  const environment = readEnv(ctx, 'PAYPAL_ENV') === 'live' ? 'live' : 'sandbox'
  return { client: paypalExpress({ clientId, clientSecret, webhookId: readEnv(ctx, 'PAYPAL_WEBHOOK_ID'), environment }), clientId }
}
