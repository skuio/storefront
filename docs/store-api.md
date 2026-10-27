# Store API v1 — the contract between a store and its operations system

Base URL: `https://<store>/api/store/v1` — or `https://<store>/api/skuio/v1`, the same API at the
path SKU.io's Storefront integration calls (both are permanent) · Auth: `Authorization: Bearer <key>` — a connection key issued by the
owner-approved connect flow below, or the `STORE_API_KEY` secret as a break-glass
· JSON in and out · money is `{ "amount": <integer minor units>, "currency": "USD" }` ·
timestamps are ISO-8601 UTC · errors are `{ "error": { "code", "message", "details" } }`.

Machine-readable: `docs/api/store-api-v1.openapi.yaml`. The SKU.io "Storefront" integration
is the first consumer; anything that can speak this contract can run the store.

| Method | Path | Purpose |
|---|---|---|
| POST | `/connect/token` | Trade an approved connect code for a per-connection key. The one unauthenticated endpoint. |
| GET | `/connect` | The connection behind this key (`null` for the secret). |
| DELETE | `/connect` | Revoke the connection behind this key. |
| GET | `/health` | Store identity, counts, whether an owner exists, which connection is calling, server time. Used by "Test connection". |
| GET | `/orders` | Orders changed since a watermark, oldest first, keyset-paged. |
| GET | `/orders/{id}` | One order with lines, payment, addresses, fulfilments. |
| PATCH | `/orders/{id}` | Stamp `external_reference`, record a payment status, or cancel. |
| POST | `/orders/{id}/fulfillments` | Push a shipment (idempotent per `external_id`); the store emails the buyer. |
| PUT | `/inventory` | Batch upsert of available quantities per SKU. |
| GET | `/products` | The catalog the store holds, oldest-updated first, keyset-paged. |
| GET | `/products/{sku}` | One product, active or not. |
| PUT | `/products` | Batch upsert of products (≤ 200 per call). |
| DELETE | `/products/{sku}` | Deactivate a product (it stays for order history). |
| GET | `/categories` | The category tree as a flat list, parents before children. |
| PUT | `/categories` | Batch upsert of the category tree. |
| GET | `/quotes` | Quote requests and offers changed since a watermark, oldest first, keyset-paged. |
| GET | `/quotes/{id}` | One quote with its lines. |
| PATCH | `/quotes/{id}` | Price it (`offer`), stamp `external_reference`, or withdraw it. |

## Connecting from SKU.io

The store is its own authorization server. Nobody pastes a key: the owner approves the
consumer in the browser, and the consumer trades a one-time code for a key it alone holds.

1. **Owner exists.** The merchant runs `npm run owner:create -- --email … --name …` once
   against the deployed store. `GET /health` reports `owner_configured: true` from then on;
   until it does, there is nobody to approve anything and the consumer should say so.
2. **Browser step.** The consumer sends the owner's browser to
   `https://<store>/admin/connect?client_id=<your system>&redirect_uri=<https url>&state=<opaque>&tenant=<account name>&scope=orders,payments,fulfillments,inventory,catalog,quotes`
   (SKU.io sends `client_id=skuio`).
   The store asks the owner to sign in (password, or an emailed reset if forgotten), then shows who
   is asking, what it may do, and the host the browser will be sent to. Approve → `302 <redirect_uri>?code=…&state=…`.
   Deny → `302 <redirect_uri>?error=access_denied&state=…`. `state` is opaque to the store and
   echoed untouched; the consumer must sign it and check it on return.
3. **Token step, server to server.** `POST /connect/token` with `{ "code", "redirect_uri" }` (no auth)
   → `201 { "data": { "api_key": "sk_store_…", "connection": { … } } }`. The key appears exactly
   once; store it encrypted. A replay is `400 invalid_grant`, and so is a `redirect_uri` that differs
   from the one used in step 2. Codes live 10 minutes.
4. **Use it.** `Authorization: Bearer sk_store_…` on every other endpoint. `GET /connect` says which
   connection is calling; `DELETE /connect` revokes it (204), after which the key is a 401.

Redirect rules: `redirect_uri` must be absolute `https` (plain `http` is allowed only for
`localhost`, `*.localhost` and `*.test`, so a developer's SKU.io works), must not carry a fragment
or credentials, and `client_id` is any 2–63 lowercase letters, digits, dots, dashes or underscores
naming your system (`skuio` is shown as "SKU.io"; others are shown as sent). Scopes are the six listed;
they are shown to the owner, travel with the connection and are **enforced per endpoint**:
`orders` for `GET`/`PATCH /orders…`, `payments` additionally for a `PATCH` that carries `payment`
(marking an order paid, refunded or failed), `fulfillments` for `POST /orders/{id}/fulfillments`,
`inventory` for `PUT /inventory`, `catalog` for `/products…` and `/categories…`, `quotes` for `/quotes…`. A connection that
lacks one gets `403 forbidden`. The `STORE_API_KEY` secret is not scoped.

**There is no endpoint that creates an order.** Orders come only from the store's own checkout,
which prices every line from the store's database, or from a buyer accepting a quote; the API can
read orders, stamp a reference, record a payment, cancel and add shipments — never invent a sale or
change what was bought. A key with `quotes` can put a price in front of a buyer; only the buyer can
turn it into an order.

The owner can see every connection at `/admin/connections` (name, tenant, key prefix, last used) and
revoke any of them. Revoking in the store and `DELETE /connect` from the consumer are the same
operation.

The owner's order list is `/admin/orders` (search by number, email or name; status and source filters; paged), backed by
`store.orders.search()`. Orders copied in from an earlier platform at cutover carry `metadata.imported_from` (e.g.
`"woocommerce"`) and `metadata.original_number`: the list tags them, and search finds them by the old number. Keep
their `updated_at` before the consumer's import start date so the Store API's `updated_since` never hands them out as
new.

### Connecting an operations system other than SKU.io

Nothing in the store is specific to SKU.io. Any ERP, OMS or integration platform (NetSuite, Odoo,
Cin7, an n8n or Make workflow, a script) connects the same way:

1. Get a key: run the connect flow above with your own `client_id`, or have the owner set
   `STORE_API_KEY` for a quick start.
2. Poll `GET /orders?updated_since=<last cursor>` (every few minutes) and create the order in your
   system; `PATCH /orders/{id}` with `external_reference` so both sides share the number.
3. Push shipments with `POST /orders/{id}/fulfillments` (the store emails tracking to the buyer).
4. Push stock with `PUT /inventory`.
5. Optionally own the catalog: `PUT /products`, `PUT /categories` (or read the store's with
   `GET /products`, `GET /categories` to import and map it first).

Several systems can be connected at once, each with its own revocable key — useful for running an
old and a new ERP side by side during a switch.

**Break-glass.** The `STORE_API_KEY` Worker secret still authenticates every endpoint, so a store
whose owner is unreachable can be operated, and a brand-new store can be seeded before an owner
exists. It is not a connection: `GET /connect` returns `null` for it and `DELETE /connect` is a 409.
Rotate it on the Worker. Both sign-in and code exchange lock an address after repeated failures
(`429 rate_limited`).

## Orders

`GET /orders?updated_since=2026-09-13T00:00:00Z&limit=100&cursor=…` returns
`{ "data": [Order…], "next_cursor": "…"|null }`. Ordering is `updated_at, id` ascending so
a consumer can keep a watermark; `updated_since` is inclusive, so overlap the previous
watermark by a minute and de-duplicate by `id`.

```json
{
  "id": "ord_01J9…", "number": "1042",
  "status": "paid",
  "payment": {
    "status": "paid", "provider": "stripe", "reference": "pi_3UF…", "method_label": "Card", "paid_at": "…",
    "amount_received": { "amount": 98910, "currency": "USD" },
    "fee": { "amount": 2898, "currency": "USD" },
    "net": { "amount": 96012, "currency": "USD" },
    "transaction_id": "ch_3UF…",
    "fee_reported_at": "…"
  },
  "currency": "USD", "subtotal": {…}, "shipping": {…}, "tax": {…}, "discount": {…}, "total": {…},
  "customer": { "id": "cus_…", "email": "…", "name": "…", "phone": "…" },
  "shipping_address": { "name", "line1", "line2", "city", "state", "postal_code", "country" },
  "billing_address": null,
  "shipping_method": { "code": "us", "name": "Free shipping (United States)" },
  "lines": [{ "id": "lin_…", "sku": "VDCANSX9005", "name": "…", "quantity": 1, "unit_amount": {…}, "total_amount": {…}, "fulfilled_quantity": 0 }],
  "fulfillments": [],
  "external_reference": null, "notes": null, "metadata": {},
  "created_at": "…", "updated_at": "…", "paid_at": "…", "cancelled_at": null
}
```

`number` is the human order number the buyer sees, with the store's `orders.numberPrefix` (`"VLD4200"`;
plain `"1042"` without a prefix). New numbers start at `orders.numberStart` (default 1001) or one above the
highest order on file, whichever is larger. Address orders by `id`, never by `number`.

Order status: `pending_payment | paid | processing | partially_fulfilled | fulfilled | cancelled | refunded`.

`pending_payment` means the buyer completed the store's checkout (contact, address, shipping
method, priced lines) and payment has not been confirmed. For a processor adapter (`stripe`)
that is a hosted checkout the buyer may still be on — or may have abandoned. **A processor
checkout still unpaid 24 hours after `created_at` is expired**: the store moves it to
`cancelled` (with `cancelled_at`) the next time it does housekeeping, which happens lazily
at the start of `GET /orders` and of every checkout, so no cron is involved and a consumer
never sees an abandoned checkout as live for longer than a day. Lines are kept for the
record. `manual` orders never expire: they wait until the operations system marks them paid.
If the processor reports a payment for an order that was already expired, the store marks it
`paid` and reopens it (`cancelled_at` back to null, `updated_at` bumped) — money arrived, and
a paid order is never lost — so a consumer that mirrors `cancelled` must accept a later
`paid`. `payment.provider` is set as soon as the adapter starts (`stripe`, `manual`), before
`payment.status` becomes `paid`.

### What the processor captured and kept

`payment` carries what the processor actually took, so an operations system never has to call
Stripe or PayPal itself. Money values are the same `{ amount, currency }` (integer minor units)
as every other amount:

| Field | Meaning | Stripe | PayPal |
|---|---|---|---|
| `amount_received` | What the processor captured for this order | PaymentIntent `amount_received`, in the charge currency | capture `seller_receivable_breakdown.gross_amount` |
| `fee` | What the processor kept, **in its settlement currency** (may differ from the order's) | `balance_transaction.fee` / `.currency` | `paypal_fee` |
| `net` | `amount_received` − `fee`, in the settlement currency | `balance_transaction.net` | `net_amount` |
| `transaction_id` | The processor's charge / capture id | `ch_…` (the intent's `latest_charge`) | capture id (also `reference`) |
| `fee_reported_at` | When the store recorded the fee (ISO 8601) | | |

All five are `null` until known. The Stripe and PayPal adapters record them when they confirm the
payment (webhook or the buyer's return). Stripe can create the balance transaction a moment after
the charge, so `fee` may still be `null` then; `GET /orders/{id}` fills it in: for a paid (or
since refunded) `stripe`/`paypal` order whose `fee` is `null`, the store asks the processor first,
stores the answer and returns it. If the processor is unreachable the GET still succeeds, with
`fee: null`. The list endpoint never calls a processor. Recording a fee bumps the order's
`updated_at`, so the next `GET /orders?updated_since=` returns it. `manual`, `bitcoin` and `btcpay`
orders always have all five `null`; a fee is never invented, and a processor-side refund does not
change them.

`PATCH /orders/{id}` accepts any of `external_reference` (string), `status: "cancelled"`,
`payment: { "status": "paid"|"refunded"|"failed", "provider"?, "reference"?, "paid_at"? }`
(how a `manual` order gets marked paid from the operations system).

`POST /orders/{id}/fulfillments` body:
```json
{ "external_id": "sof_812", "carrier": "UPS", "service": "Ground", "tracking_number": "1Z…",
  "tracking_url": "https://…", "shipped_at": "…", "lines": [{ "sku": "VDCANSX9005", "quantity": 1 }],
  "notify_customer": true }
```
Returns `201` with the fulfilment the first time and `200` with the same one on redelivery.
The store raises `fulfilled_quantity` on the lines, moves the order to `partially_fulfilled`
or `fulfilled`, and emails the buyer once per fulfilment.

## Quotes (request for quote)

A buyer asks for a price instead of checking out — a volume order, a lead-time question, a
purchase-order buyer. **No account is needed:** a guest gives a name and an email, the store files
the request under a customer keyed by that email (exactly as a guest checkout does) and emails them
a link back to the quote. A signed-in buyer also finds it at `/account/quotes/`.

```
buyer (guest or signed in) ─▶ POST /api/quotes ─▶ quote(requested) ─▶ emails buyer + merchant
SKU.io GET /quotes (updated_since) ─▶ prices it ─▶ PATCH /quotes/{id} { offer } ─▶ quote(quoted) ─▶ "your quote is ready"
buyer accepts on /quotes/{id}/ ─▶ quote(accepted) + order(pending_payment, manual) ─▶ GET /orders (metadata.quote_id)
                       declines ─▶ quote(declined)        offer passes expires_at ─▶ quote(expired) ─▶ re-offer to renew
```

`GET /quotes?updated_since=…&cursor=…&limit=50` returns `{ "data": [Quote…], "next_cursor" }` with
the same watermark discipline as orders (`updated_at, id` ascending, inclusive, de-duplicate by `id`).
Offers past their `expires_at` become `expired` before the page is read, so no cron is involved.

```json
{
  "id": "quo_01J9…", "number": "Q1001", "status": "requested", "currency": "USD",
  "customer": { "id": "cus_…", "email": "buyer@agency.gov", "name": "Sam Procurement", "phone": null },
  "company": "Field Office 7", "message": "Need delivery before the end of the fiscal year.",
  "shipping_address": null,
  "lines": [{ "id": "qln_…", "sku": "BAG-40L", "name": "40L patrol pack", "quantity": 40,
              "list_amount": { "amount": 24900, "currency": "USD" }, "unit_amount": null, "total_amount": null }],
  "subtotal": null, "shipping": null, "tax": null, "total": null, "note": null, "expires_at": null,
  "external_reference": null, "order_id": null, "decline_reason": null, "metadata": {},
  "created_at": "…", "updated_at": "…", "quoted_at": null, "accepted_at": null, "declined_at": null, "cancelled_at": null
}
```

Quote status: `requested | quoted | accepted | declined | expired | cancelled`. `list_amount` is the
catalog price when the buyer asked, for reference; the priced fields stay `null` until an offer.
Sold-out products can be requested — lead time is part of the answer.

`PATCH /quotes/{id}` accepts any of `external_reference`, `status: "cancelled"` (withdraw; an
accepted quote is a `409` — cancel its order), and `offer`:

```json
{ "offer": {
    "lines": [{ "sku": "BAG-40L", "quantity": 40, "unit_amount": { "amount": 19900, "currency": "USD" } },
              { "sku": "CUSTOM-PATCH", "name": "Embroidered unit patch", "quantity": 40, "unit_amount": { "amount": 450, "currency": "USD" } }],
    "shipping": { "amount": 6500, "currency": "USD" }, "tax": null,
    "expires_at": "2026-11-30T00:00:00Z", "note": "Ships in 3 weeks. Net 30 on PO.",
    "notify_customer": true } }
```

The offer **replaces** the lines: change a quantity, drop a line, or add an alternative (a SKU the
store does not list needs a `name`). Currency must be the store's; `expires_at` must be in the
future (or `null`, open-ended). It moves the quote to `quoted` and, unless `notify_customer` is
`false`, emails the buyer a link to accept. Re-offering a `quoted` or `expired` quote revises it;
`accepted`, `declined` and `cancelled` are final (`409`).

**Acceptance is the buyer's.** It places an order at exactly the offered lines, shipping and tax —
pay-later (`payment.provider: "manual"`, never expired as an abandoned checkout), shipping method
`{ "code": "quote" }`, `metadata.quote_id`, `metadata.quote_number`, `metadata.po_number` when the
buyer gave one, and `metadata.quote_external_reference` when you stamped one. It arrives through
`GET /orders` like any other order; mark it paid with `PATCH /orders/{id}` when the invoice is paid.

The store's merchant address hears about every request and answer (`QUOTE_NOTIFICATION_EMAIL`, else
`ORDER_NOTIFICATION_EMAIL`). One email address may send `quotes.maxRequestsPerHour` requests an hour
(default 5); quote numbers take `quotes.numberPrefix` (default `Q`) from `quotes.numberStart` (1001).

## Reading the catalog

The write endpoints alone make the operations system the only possible source of truth. The
read endpoints are what let it **import** a store that already has a catalog, map those
products to its own, and notice drift afterwards — the same import-then-map shape every other
sales channel uses.

`GET /products?updated_since=…&cursor=…&limit=50&active=true` returns
`{ "data": [Product…], "next_cursor": "…"|null }`. Ordering is `updated_at, sku` ascending, so
the same watermark discipline as orders applies: overlap the previous watermark and
de-duplicate by `sku`. `limit` is 1–200 (default 50). `active` is optional — **omit it and
inactive products come back too**, which is how a withdrawal becomes visible. A product's
`updated_at` also moves when its stock changes (a `PUT /inventory` with a new quantity, or a
paid or cancelled order), so polling `updated_since` picks up stock drift without a full sweep. A `limit`,
`updated_since`, `active` or `cursor` the store did not issue is a `422`, never a silent clamp.

```json
{
  "sku": "VDCANSX9005",
  "name": "Acura NSX 1990-2005 Vertical Lambo Doors",
  "slug": "acura-nsx-1990-2005-vertical-lambo-doors",
  "description_html": "…", "short_description_html": null,
  "price": { "amount": 119900, "currency": "USD" },
  "compare_at": null,
  "attributes": { "Fits": "1990-2005" },
  "active": true, "position": 0, "legacy_path": "/shop/acura/nsx-1990-2005/…/",
  "categories": [{ "id": "11", "slug": "nsx-1990-2005", "name": "NSX 1990-2005" }],
  "images": [{ "url": "https://cdn.example.com/nsx.jpg", "alt": "NSX", "position": 0 }],
  "inventory": { "available": 12, "allow_backorder": false, "updated_at": "2026-09-14T01:20:00.000Z" },
  "created_at": "2026-09-10T22:03:11.000Z",
  "updated_at": "2026-09-14T01:20:00.000Z"
}
```

`images[].url` is **always an absolute URL** the consumer can load as-is. A store may keep
images as bare filenames or paths (`"civic.jpg"`, served by the site at a fingerprinted
`/_astro/civic.<hash>.jpg`); the API resolves each through the store's `imageUrl` option of
`handleStoreApi` — the reference template passes its `resolveImage()` against the site URL —
and otherwise passes an absolute URL through unchanged and resolves a relative one against the
request origin. That last fallback is only a guess at where the file lives: a store whose
assets are fingerprinted must pass `imageUrl`, or the URL will 404. URLs pushed through
`PUT /products` (hosted images) come back exactly as sent.

Two shapes to handle rather than assume away. `inventory` is `null` when the store holds no
stock row for that SKU, which is **not** the same as `available: 0`. And a `categories` entry
carries `slug: null, name: null` when the product links to a category id the store never
received — the link is reported rather than dropped, so the importer can see the gap.

`GET /products/{sku}` returns one product in the same shape, `404 not_found` when unknown.
Inactive products are readable.

`GET /categories?cursor=…&limit=500` returns `{ "data": [Category…], "next_cursor": … }`,
ordered by `(parent_id, position, id)` with a null parent sorting first, so parents arrive
before their children within a branch. Each row carries `product_count`. `limit` is 1–1000
(default 500).

## Inventory, products, categories

`PUT /inventory` `{ "items": [{ "sku", "available": 12, "allow_backorder": false }] }` (`available` is a non-negative integer) →
`{ "data": { "updated": 12, "unknown_skus": [] } }`. Status is derived: `available <= 0`
→ `out_of_stock` (or `backorder` when allowed), `<= low_stock_threshold` → `low_stock`,
else `in_stock`.

`PUT /products` `{ "products": [{ "sku", "name", "slug"?, "description_html"?, "short_description_html"?,
"price": {…}, "compare_at_price": {…}|null, "images": [{ "url", "alt"? }], "category_ids": ["…"],
"attributes": { "Fits": "…" }, "active": true, "position"? }] }` → `{ "data": { "upserted": n } }`.

`PUT /categories` `{ "categories": [{ "id", "name", "slug"?, "parent_id", "description_html"?,
"image": { "url", "alt"? }|null, "position" }] }` → `{ "data": { "upserted": n } }`. Ids are the
operations system's ids as strings; slugs default to a slugified name and stay stable once set.

**Migration-safe identity.** A category is identified by `id`. When an `id` is unknown to the
store but a category with the same slug under the same `parent_id` already exists (a seeded
tree, an earlier system's ids), the store **adopts** that row: it is re-keyed to the incoming
`id` and its products and child categories move with it — no suffixed duplicate is created.
When the `id` is known and a same-parent row owns the natural slug, that duplicate is merged
into the incoming category. Parents are resolved within the batch first (by id, then by the
same rule), so a whole tree pushed with new ids over a seeded tree lands on the existing
nodes. A slug is only suffixed (`<slug>-<id>`) when it is owned by a category under a
*different* parent, or when the batch itself claims the same slug twice. Products are always
keyed by SKU and are unaffected by category re-keying. A second identical push changes nothing.

## Errors

`401 unauthorized` (missing/wrong key) · `404 not_found` · `422 validation_failed` (with
`details` per field) · `409 conflict` (e.g. cancelling a fulfilled order) · `400 invalid_grant` (code
exchange) · `429 rate_limited` (repeated sign-in or exchange failures from one address).
