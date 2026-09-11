# SKU.io Storefront API — v1 contract

The API a store talks to when `storefront.config.ts` uses `skuioProvider`.
It does not exist in SKU.io yet. This document and
[`api/storefront-v1.openapi.yaml`](api/storefront-v1.openapi.yaml) are the
contract the SKU.io side is built to, and `@skuio/storefront`'s provider is
already implemented and tested against it (with fixtures drawn from the
spec's examples). When the endpoints ship, the provider needs no change.

Base URL: `https://<tenant>.sku.io/api/storefront/v1`

## Design rules

1. **Read-mostly, storefront-scoped.** A store can read its catalogue and
   availability and can *create a checkout*. It cannot read orders,
   customers, costs, or other storefronts, and it cannot write anything else.
2. **The token identifies the storefront.** One token per storefront, prefix
   `sf_live_` / `sf_test_`. No admin PAT is ever accepted on these routes.
   Scopes are fixed: `catalog:read`, `availability:read`, `checkout:create`.
3. **Availability is a status, never a count.** Exact stock is competitive
   information and this token is deployed on the public internet. Stores get
   `in_stock | low_stock | out_of_stock | backorder | preorder`.
4. **SKU.io prices and creates the checkout.** The store posts SKUs and
   quantities; SKU.io resolves the customer-group price list, applies the
   storefront's shipping options, creates the session on the *tenant's*
   processor (Stripe or Square, whichever the tenant has connected) and
   returns a URL. The store holds no processor key. The order is born in
   SKU.io, attributed to the storefront as a sales channel.
5. **Money is integer minor units + currency, everywhere.** Same shape as
   the SDK's `Money`.
6. **Cursor pagination, `updated_since` for incremental reads.** Catalogues
   are rebuilt at deploy time; incremental reads keep that cheap.
7. **Errors are `{ "error": { "code", "message" } }`** with 401 (bad token),
   403 (token lacks scope / wrong storefront), 404, 422 (validation,
   including unpurchasable SKU), 429 (rate limit, `Retry-After`).

## Endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/storefront` | any | Who am I: name, currency, locale, domains, checkout options |
| GET | `/categories` | `catalog:read` | Full category list (cursor-paginated) |
| GET | `/products` | `catalog:read` | Products visible to this storefront (cursor-paginated, `updated_since`) |
| GET | `/products/{sku}` | `catalog:read` | One product |
| GET | `/availability?skus=` | `availability:read` | Live availability status for up to 100 SKUs |
| POST | `/checkouts` | `checkout:create` | Create a hosted checkout; returns a URL |
| GET | `/checkouts/{id}` | `checkout:create` | Status of a checkout the store created (for success pages) |

### Field mapping to the SDK

| API | SDK `Product` |
|---|---|
| `id` | `id` |
| `sku` | `sku` |
| `name`, `slug` | same |
| `description_html`, `short_description_html` | `description`, `shortDescription` |
| `price` | `price` |
| `compare_at_price` | `compareAtPrice` |
| `category_ids` (primary first) | `categoryIds` |
| `images[].url`, `images[].alt` | `images[].src`, `images[].alt` |
| `availability.status` | `available` = status ≠ `out_of_stock`; full object on `availability` |
| `attributes` | `attributes` |

`category_ids[0]` is the category SKU.io considers primary for the
storefront. The SDK builds product URLs from its chain, so SKU.io must return
a category whose ancestor chain is what the merchant wants in the URL.

### Storefront webhooks (optional, v1)

A store may register a URL to be told when a checkout it created completes,
so it can run its own `onOrderCompleted`. `POST <url>` with body
`{ "type": "checkout.completed", "checkout": <Checkout> }` and header
`X-Skuio-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">` using
the webhook secret shown once at registration. Retried with backoff for 24h
on non-2xx. Registration is done in the SKU.io admin, not via this API.

## Customer sessions (v1.1) — the portal

A customer signs in with nothing but an email address. No passwords are
stored anywhere in the store or in SKU.io for this flow.

1. `POST /customers/session` `{ email, return_url }` — SKU.io emails a
   single-use link to `return_url?token=…` (valid 15 minutes). Always 202,
   whether or not the email is known, so the endpoint cannot be used to
   enumerate customers.
2. The store's `/account/verify` page receives the token and calls
   `POST /customers/session/exchange` `{ token }` → `{ session_token,
   expires_at, customer }`. The store keeps `session_token` in an httpOnly,
   Secure, SameSite=Lax cookie. It never reaches the browser's JavaScript.
3. Authenticated customer calls send **both** the storefront bearer token and
   `X-Customer-Session: <session_token>`:
   - `GET /customers/me` — profile and default addresses
   - `GET /customers/me/orders` — this customer's orders on this storefront
     (and, when the tenant allows it, on the tenant's other channels), newest
     first, with fulfilment status and tracking
   - `DELETE /customers/session` — sign out (revokes the token)
4. A 401 on any `X-Customer-Session` call means the session is expired or
   revoked; the store clears the cookie and shows the sign-in form.

Sessions last 30 days and are bound to the storefront that created them.
Reorder is a store-side action — the order's lines go into the cart — so
it needs no endpoint.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/customers/session` | storefront | Send a magic link |
| POST | `/customers/session/exchange` | storefront | Turn the link's token into a session |
| GET | `/customers/me` | storefront + customer | Profile |
| GET | `/customers/me/orders` | storefront + customer | Order history with fulfilment |
| DELETE | `/customers/session` | storefront + customer | Sign out |

## Deferred to v1.2

- **Search** (`GET /products?q=`) — full-text over name/sku/attributes.
- **Price lists by customer group on read** — v1 returns the storefront's
  default group; B2B pricing for a signed-in customer arrives here.
- **Saved payment methods / net terms at checkout** for B2B accounts.

## What SKU.io has to build (in order)

1. Storefront token type + the three scopes; middleware that rejects PATs.
2. `storefront` sales-channel type: tenant → N storefronts, each with a
   domain, token, catalogue visibility rule, default customer group, shipping
   options, processor.
3. The seven endpoints above, backed by existing product/category/inventory
   models and the existing Stripe/Square processor layer used by POS.
4. Checkout completion → sales order on the storefront channel (this is what
   makes "orders land in SKU.io" true with zero store-side integration).
