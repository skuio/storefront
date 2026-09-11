/**
 * Stripe-specific entry point, kept separate so stores on another processor
 * never pull the Stripe SDK into their bundle.
 *
 *   import { createStripeCheckout, parseStripeWebhook } from '@skuio/storefront/stripe'
 */
export {
  createStripeCheckout,
  CheckoutError,
  type CheckoutItem,
  type CreateStripeCheckoutOptions,
  type CheckoutResult,
} from './checkout/stripe.js'
export {
  parseStripeWebhook,
  orderFromSession,
  referenceFromSessionId,
  WebhookSignatureError,
  type StorefrontEvent,
  type ParseStripeWebhookOptions,
} from './webhook/stripe.js'
