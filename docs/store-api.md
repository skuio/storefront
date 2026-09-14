# Store API v1 — the contract between a store and its operations system

Base URL: `https://<store>/api/skuio/v1` · Auth: `Authorization: Bearer <key>` — a connection key issued by the
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
| GET | `/products` | The catalogue the store holds, oldest-updated first, keyset-paged. |
| GET | `/products/{sku}` | One product, active or not. |
| PUT | `/products` | Batch upsert of products (≤ 200 per call). |
| DELETE | `/products/{sku}` | Deactivate a product (it stays for order history). |
| GET | `/categories` | The category tree as a flat list, parents before children. |
| PUT | `/categories` | Batch upsert of the category tree. |

## Connecting from SKU.io

The store is its own authorization server. Nobody pastes a key: the owner approves the
consumer in the browser, and the consumer trades a one-time code for a key it alone holds.

1. **Owner exists.** The merchant runs `npm run owner:create -- --email … --name …` once
   against the deployed store. `GET /health` reports `owner_configured: true` from then on;
   until it does, there is nobody to approve anything and the consumer should say so.
2. **Browser step.** The consumer sends the owner's browser to
   `https://<store>/admin/connect?client_id=skuio&redirect_uri=<https url>&state=<opaque>&tenant=<name>&scope=orders,fulfillments,inventory,catalog`.
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
or credentials, and `client_id` must be one the store knows (`skuio`). Scopes are the four listed;
they describe intent to the owner and travel with the connection — v1 does not yet enforce them
per endpoint.

The owner can see every connection at `/admin/connections` (name, tenant, key prefix, last used) and
revoke any of them. Revoking in the store and `DELETE /connect` from the consumer are the same
operation.

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
  "payment": { "status": "paid", "provider": "stripe", "reference": "pi_3UF…", "method_label": "Card", "paid_at": "…" },
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

## Reading the catalogue

The write endpoints alone make the operations system the only possible source of truth. The
read endpoints are what let it **import** a store that already has a catalogue, map those
products to its own, and notice drift afterwards — the same import-then-map shape every other
sales channel uses.

`GET /products?updated_since=…&cursor=…&limit=50&active=true` returns
`{ "data": [Product…], "next_cursor": "…"|null }`. Ordering is `updated_at, sku` ascending, so
the same watermark discipline as orders applies: overlap the previous watermark and
de-duplicate by `sku`. `limit` is 1–200 (default 50). `active` is optional — **omit it and
inactive products come back too**, which is how a withdrawal becomes visible. A `limit`,
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
