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
| GET | `/payouts` | The processors' payouts (Stripe payouts, PayPal withdrawals), oldest first, keyset-paged. |
| GET | `/payouts/{provider}/{id}` | One payout, with its line count. |
| GET | `/payouts/{provider}/{id}/lines` | What the payout is made of: charges, refunds, disputes, fees, … |

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

## Payouts

A payout is money a processor sent to (or pulled from) the merchant's bank. The store reads its
processors with the keys it already holds and itemises each payout, so an operations system can
post one accounting document per payout and match the bank deposit to the cent, without ever
holding Stripe or PayPal credentials. Read with the `orders` scope (or the `STORE_API_KEY`
secret). The `stripe` and `paypal` adapters serve payouts; `manual`, `bitcoin` and `btcpay` have
none.

| Method | Path | Returns |
|---|---|---|
| GET | `/payouts?provider=stripe&created_since=2026-10-01T00:00:00Z&paypal_mode=withdrawal&cursor=…&limit=50` | `{ "data": [Payout…], "next_cursor": "…"\|null, "providers": ["paypal", "stripe"], "accounts": [{ "provider": "paypal", "account_id": "…" }, …] }` |
| GET | `/payouts/{provider}/{id}` | `{ "data": Payout }` |
| GET | `/payouts/{provider}/{id}/lines?cursor=…&limit=100` | `{ "data": [PayoutLine…], "next_cursor": "…"\|null }` |

`paypal_mode` is `withdrawal` (the default) or `balance` and chooses what a PayPal payout is (see
**PayPal** below); any other value is `422`. Stripe ignores it. It is also accepted on the two
single-payout endpoints, where it is only validated: a PayPal payout id says which mode it belongs to.
Pass the same `paypal_mode` on every page of a list.

**List.** Ordered by `created_at, provider, id` ascending. `provider` is optional: without it the
list merges every payout-capable processor on the store (`providers` names them; empty when there
are none). `created_since` is inclusive and defaults to 90 days ago. `limit` is 1–100 (default 50).
The cursor is opaque: echo it back. It freezes the run's lower bound (`created_since`, or 90 days
before the first page), so later pages never recompute it from the clock. **A merged list (no
`provider`) stops at now minus the largest reporting lag among the merged processors** (PayPal's,
three hours unless the store configured another `reportingLagMs`; Stripe none) for every
processor, so a late-reported PayPal withdrawal can never land behind a cursor that a Stripe payout
already moved past; that cutoff is also fixed by the first page and carried in the cursor. A
single-provider list keeps that processor's own horizon (Stripe: up to now; PayPal: its lag back). Because the list can merge two processors, a consumer that
records per-processor sync errors should page each provider separately (`?provider=stripe`, then
`?provider=paypal`): a permission error on one fails the whole merged request. An unknown provider,
or one without payouts, is `404 not_found`.

**`accounts`** names the processor account of every payout-capable provider on the store (not only
the one `provider` asks for): `[{ "provider": "paypal", "account_id": "EXAMPLEPAYER01" },
{ "provider": "stripe", "account_id": "acct_1ExAmPlE00000000" }]`, ordered by provider. It is the same
id the payouts carry in `account_id`, read cheaply (cached, or learned while listing), so a consumer
can notice the store switched processor accounts even when no new payout has arrived. A provider
whose account cannot be read (a Stripe key without account read; PayPal before any search has named
the payer and without Log in with PayPal) is left out, never an error.

**Payout:**
```json
{ "id": "po_1ExAmPlE0000000000Payout", "provider": "stripe", "account_id": "acct_1ExAmPlE00000000",
  "status": "paid", "amount": { "amount": 49688, "currency": "usd" },
  "arrival_date": "2026-11-03", "created_at": "2026-11-03T00:08:09Z",
  "method": "standard", "destination_label": "Bank ••6789", "line_count": 2 }
```

| Field | Meaning |
|---|---|
| `account_id` | The processor account that paid out: Stripe `acct_…`; PayPal the merchant's payer id (from Log in with PayPal's userinfo, else Transaction Search's `account_number`, else the app's client id). Two stores on one processor account report the same id. |
| `status` | `pending \| in_transit \| paid \| failed \| canceled`. Only `paid` payouts are final; `failed` and `canceled` never settle anything (Stripe puts their transactions in a later payout). A PayPal balance day is `pending` until the whole day is older than the reporting lag. |
| `amount` | What reached the bank, integer minor units, **negative for a debit** (Stripe pulling money to cover a negative balance). PayPal withdrawal: the withdrawal's absolute value. PayPal balance day: the day's net movement (negative on a day of more refunds than sales). |
| `arrival_date` | `YYYY-MM-DD` the bank receives it (Stripe), the withdrawal date or the balance day (PayPal). |
| `created_at` | ISO 8601 UTC, second precision. A PayPal balance day: its last second (`2026-11-02T23:59:59Z`). |
| `method` | Stripe `standard` / `instant`; PayPal `withdrawal` (T0400), the withdrawal's T-code (`T0401` auto-sweep, …), or `balance` (a balance day). |
| `destination_label` | e.g. `Bank ••6789` when the key may read the bank account; else `null`. `null` for a PayPal withdrawal; `PayPal balance` for a balance day. |
| `line_count` | How many lines `/lines` returns. **May be `null` in the list** (counting a Stripe payout costs extra calls; a PayPal withdrawal whose previous withdrawal is not at least 14 days after where the list's read starts, i.e. before `created_since`). `GET /payouts/{provider}/{id}` fills it, except for a Stripe payout of more than 1,000 lines (counting it would take more than ten Stripe calls), where it is `null`. **Page `/lines` to exhaustion rather than trusting `line_count`** (SKU.io does). A change in `line_count` means the lines changed. |

**PayoutLine:**
```json
{ "id": "txn_1ExAmPlE000000000Charge1", "type": "charge", "category": "charge",
  "source_id": "ch_1ExAmPlE00000000000Charge1", "order_id": "ord_example0000000000001", "order_number": "15000",
  "payment_reference": "pi_…",
  "gross": { "amount": 17078, "currency": "usd" }, "fee": { "amount": 525, "currency": "usd" },
  "net": { "amount": 16553, "currency": "usd" },
  "fee_details": [{ "type": "stripe_fee", "amount": 525, "description": "Stripe processing fees" }],
  "created_at": "2026-10-27T12:53:15Z", "available_on": "2026-11-03", "description": "Example Store order EX15000" }
```

| Field | Meaning |
|---|---|
| `id` | Stripe balance transaction `txn_…`; PayPal transaction id (`carry_in:…` / `carry_out:…` for a carry line). |
| `type` | The processor's own type: Stripe balance transaction `type`, PayPal T-code. |
| `category` | Normalised, table below. |
| `source_id` | Stripe: the object behind it (`ch_…`, `py_…`, `re_…`, `du_…`, or `null` for a billing fee). PayPal: the transaction id (for a carry line, the withdrawal or transaction whose `ending_balance` it is). For a charge it equals the order's `payment.transaction_id`. |
| `order_id`, `order_number` | The store order, from the charge's `metadata.order_id` / `order_number` (Stripe; a refund or dispute reads the charge it is for) or the transaction's `custom_field` (PayPal, set to the order id at checkout; a refund uses the payment it refunds). When only one of the two is known, the store fills the other from its own orders. `null` for lines no order owns (fees, conversions, test charges). `order_number` has no prefix (`"15000"`). |
| `payment_reference` | The order's `payment.reference` when known: Stripe PaymentIntent `pi_…`; PayPal the capture (transaction) id, for a refund the one it refunds. Additive to SKU-8600's contract. |
| `gross`, `fee`, `net` | Integer minor units **in the payout currency** (the processor has already converted a charge taken in another currency). Always `gross − fee = net`. |
| `fee_details` | Stripe's breakdown (`stripe_fee`, `tax`, `application_fee`, …); PayPal one `paypal_fee` row when there is a fee. `amount` is integer minor units in the payout currency. |
| `available_on` | `YYYY-MM-DD` the funds became available (Stripe); `null` for PayPal. |

**Sign conventions.** The signs are the processor's balance: money in is positive, money out
negative, and `fee` is what the processor kept (negative when it gave a fee back). So a refund is
`gross −3000, fee 0, net −3000`; a lost dispute `gross −5000, fee 1500, net −6500`; its reversal when
won `gross 5000, fee −1500, net 6500`; a standalone Stripe billing fee `gross −200, fee 0, net −200`.
For PayPal, `gross` is the transaction amount and `fee` is the negated PayPal `fee_amount`.
**The `net` of a payout's lines sums to its `amount`** (Stripe's own `payout` row is left out of the
lines; the kit's tests assert this on a real payout).

| Stripe `reporting_category` (else `type`) | PayPal T-code | `category` |
|---|---|---|
| `charge`, `payment`, `charge_failure` | T0000–T0013, T0700 | `charge` |
| `refund`, `payment_refund`, `refund_failure`, `payment_failure_refund` | T1107 (merchant refund) | `refund` |
| `dispute` | T1106 (payment reversal by PayPal), T1201 (chargeback) | `dispute` |
| `dispute_reversal` | T1202 (chargeback reversal) | `dispute_reversal` |
| `fee`, `stripe_fee`, `tax`, `network_cost` | T0100–T0199, T1108 (fee reversal), T1109 (fee refund) — a fee given back is positive, as PayPal reports it | `fee` |
| `risk_reserved_funds`, `risk_reserve_released`, `reserve_transaction`, `reserved_funds` | T1105 (release of a general account hold), T1500–T1599 (holds) | `reserve` |
| `adjustment`, `other_adjustment` | T0200–T0299 (currency conversion), T1900–T1999 | `adjustment` |
| `transfer`, `transfer_reversal`, `topup`, `topup_reversal` | T0300–T0399, T1101 (withdrawal reversed), a reversed (`V`) withdrawal | `transfer` |
| — | `carry_in` / `carry_out` (a partial withdrawal's balance lines, below) | `balance` |
| anything else | anything else | `other` |

PayPal T1300–T1399 (authorize, reauthorize, void an authorization) never move the balance and are
never lines.

**Stripe.** A payout is a Stripe payout; its lines are `balance_transactions?payout=` (Stripe only
itemises automatic payouts: a payout sent by hand from the Dashboard has `line_count: 0` and no
lines). The list walks Stripe newest-first back to `created_since` and serves the result oldest
first; a range with more than 2,000 payouts is refused with 422 (use a later `created_since`).

**PayPal.** PayPal has no payout object: money stays in the PayPal balance until a withdrawal
(T04xx) moves it to the bank, and some merchants never withdraw (they book the PayPal balance as a
bank account). Everything is read through Transaction Search, in one of two modes the operations
system picks per store with `paypal_mode`:

- **`withdrawal`** (default): a payout is a withdrawal, and its lines are the balance movements **in
  the withdrawal's currency** after the previous withdrawal, up to it, plus the carry lines below.
  Payout id: the withdrawal's transaction id.
- **`balance`**: PayPal is a bank account in the merchant's books. A payout is one **UTC day × currency**
  that had balance movements: id `day-YYYY-MM-DD-CUR` (`day-2026-11-02-USD`), `created_at` the day's
  last second, `arrival_date` the day, `method: "balance"`, `destination_label: "PayPal balance"`,
  `amount` the Σ `net` of its lines (so it always balances), `status` `paid` once the end of the day
  is older than the reporting lag, else `pending`. Its lines are every movement settled that day
  **except withdrawals** (any status) **and withdrawal reversals** (`T1101`): those are transfers the
  merchant books between PayPal and the bank, not payout lines. A withdrawal fee (`T0102`) is a line.
  Withdrawal mode never lists balance days and balance mode never lists withdrawals; `GET` and
  `/lines` take either kind of id without `paypal_mode`.

In both modes a line is a transaction with status `S` (completed) or `V` (completed, then reversed:
the original did move the balance, and its refund or reversal is a line of its own, in whichever
payout it falls). Pending (`P`) and denied (`D`) transactions never moved the balance and are not
lines. PayPal keeps one balance per currency, so a CAD sale converted to USD shows as a `T0200`
adjustment in the USD payout. Lines are shown in settlement order (below), then transaction id;
`created_at` stays the transaction's own initiation date.

*Withdrawal-mode details.* A transaction in the same second as a withdrawal belongs to that
withdrawal. A withdrawal PayPal reversed (status `V`, the bank returned it) is no payout boundary,
but the money did leave and come back: the reversed withdrawal is a negative `transfer` line in the
payout whose interval it falls in, and its reversal (`T1101`) a positive `transfer` line in the payout
whose interval that falls in, so each payout still sums to its amount. Anything else that references
a withdrawal (a `T0102` withdrawal fee) is an ordinary line. Transactions after the latest withdrawal
belong to no payout yet.

**Carry lines (a partial withdrawal).** A withdrawal that leaves money in PayPal is itemised with two
`balance` lines worked out from PayPal's `ending_balance` (the balance in that currency after a
transaction, `transaction_info.ending_balance`):

| `type` | `id` | Amount (`gross = net`, `fee` 0) | `source_id` |
|---|---|---|---|
| `carry_in` | `carry_in:<previous withdrawal id>` | **+** the balance left in PayPal after the previous withdrawal | that withdrawal |
| `carry_out` | `carry_out:<this withdrawal id>` | **−** the balance left in PayPal after this withdrawal | this withdrawal |

`carry_in` is the first line and `carry_out` the last; a zero carry is left out (a withdrawal that
empties the balance has no `carry_out`). With them, `Σ net = amount` for a partial withdrawal too.
Receive 100 (fee 3), withdraw 40, receive 20, withdraw 77: the first payout is `charge 97, carry_out −57`
(Σ 40); the second `carry_in 57, charge 20` (Σ 77). The two lines of one boundary share the id
suffix, so a consumer can see that `carry_out:W1` and `carry_in:W1` are the same money. A withdrawal
with no earlier one in PayPal's history (three years) takes its `carry_in` from the first movement
(its `ending_balance` minus its `net`; `source_id` that transaction).

Carry lines are emitted only when they reconcile: `balance after the previous withdrawal + Σ net of
the movement lines − amount = balance after this withdrawal`. If PayPal left `ending_balance` empty
on either boundary (PayPal's reference says it is empty when the search passes "one or more optional
query parameters"; the kit's range reads pass only dates, `fields=all` and paging, never a filter such
as `transaction_id` — verify on the live account that it comes back), or the
balances do not reconcile with the lines (PayPal ordered a same-second movement differently, or a
movement was regrouped), the payout has **no** carry lines — never a plug — and its lines do not sum
to its `amount`, so the consumer holds it. `line_count` counts carry lines.

**Settlement time (eCheck and other delayed payments).** A transaction is grouped by when its money
reached the balance, in both modes: its `transaction_initiation_date`, except for a payment that
waited to clear, which is grouped by its `transaction_updated_date` (its settlement). Transaction
Search has no field that says a transaction "was pending", so the rule is deliberately narrow — all
of these must hold:

1. the transaction is completed (`S`) and an incoming payment (`T0000`–`T0013`, `T0700`);
2. `transaction_updated_date` is later than `transaction_initiation_date`, by at most 14 days;
3. it was funded by an eCheck: `instrument_type` or `instrument_sub_type` contains `ECHECK` (or
   `E_CHECK`), or `instrument_type` is `BANK` and it cleared **at least a day** after it started (an
   instant bank transfer completes at once; an eCheck takes 3–5 business days);
4. no other transaction references it (`paypal_reference_id`): a refund or dispute may itself be what
   moved `transaction_updated_date`, so a referenced payment keeps its initiation date. To see such a
   refund, a read that holds a delayed payment also reads the 14 days after the payout.

Everything else keeps its initiation date. So an eCheck started before a withdrawal and cleared
after it is a line of the **next** withdrawal (or of the balance day it cleared), where its money
actually went out. Every read starts 14 days before the payout's interval (a withdrawal's previous
withdrawal, a balance day, or `created_since`) to find delayed payments started earlier; in the
list, a withdrawal's `line_count` is `null` when its previous withdrawal is less than 14 days after
where the read starts.

**PayPal payouts appear about three hours after the withdrawal.** Transaction Search lags real time
by up to three hours, so the store reads only transactions older than that: a withdrawal (and any
transaction) newer than three hours is not listed, not found by `GET /payouts/paypal/{id}` (404),
and not in any lines yet; a balance day stays `pending` until three hours after it ends. Poll again
later. Transaction Search keeps three years; each request is cut into ≤ 31-day windows (a window
PayPal finds too large is halved, down to an hour), so looking up an old payout costs one call per
month back to it.

**Known limits (PayPal).** The operations system should hold a payout whose lines do not sum to its
`amount` instead of posting it:

- **No `ending_balance`.** A partial withdrawal is balanced only by its carry lines; when PayPal does
  not report `ending_balance` for the account (or it does not reconcile, above), the payout's lines
  sum to more than its `amount` and the next one's to less. `paypal_mode=balance` has no such limit:
  a balance day always sums to its amount.
- **Delayed payments outside the rule.** A payment that cleared late but matches none of the funding
  signals above (PayPal reports no eCheck or `BANK` instrument for it), or took longer than 14 days,
  is grouped by its initiation date; in withdrawal mode its payout then does not reconcile and gets no
  carry lines. `transaction_updated_date` is when PayPal last changed a transaction, so a later change
  to a cleared eCheck (a refund or dispute more than 14 days on) can move it back to its initiation
  date, changing an earlier payout's lines and `line_count`.
- **Very high-volume PayPal accounts.** A payout read walks every transaction since the previous
  withdrawal (plus 14 days), one Transaction Search call per 500 transactions (plus one per month of
  history). An account with tens of thousands of transactions between withdrawals can need more than
  the 50 outbound requests a Cloudflare Workers Free request allows; such a store needs the Workers
  Paid plan (1,000) or a Node host, or `paypal_mode=balance`, whose day reads cover only the two weeks before it (and, with a delayed payment, the two after).

### Processor permissions

When the processor refuses the store's key (HTTP 401/403), the Store API answers **424**:
```json
{ "error": { "code": "processor_permission_missing",
  "message": "Stripe refused the store's key: …. Grant \"Balance: Read\" on the restricted key.",
  "details": { "provider": "stripe", "permission": "Balance: Read" } } }
```
`details.permission` is one of:

| Provider | `permission` | How the merchant grants it |
|---|---|---|
| `stripe` | `Payouts: Read` | Stripe Dashboard → Developers → API keys → the store's restricted key → ⋯ → Edit → **Payouts: Read** → Update key. (A standard secret key already has it.) |
| `stripe` | `Balance: Read` | Same screen → **Balance: Read** (needed for the lines). |
| `stripe` | `Balance transaction sources: Read` | Same screen → **Balance transaction sources: Read** (the lines read the charge, refund or dispute behind each row; Stripe names it `rak_balance_transaction_source_read` in the error). |
| `stripe` | `Account: Read` | Rare: a restricted key that cannot read its own account (`GET /v1/account`); same screen → give the key read access to the account. |
| `paypal` | `Transaction search` | developer.paypal.com → Apps & Credentials → **Live** → the store's app → Features → tick **Transaction search** → Save. PayPal can take a few hours to grant the new scope to the app. |
| `paypal` | `API credentials` | PayPal refused the client id and secret themselves (its OAuth token endpoint answered 401/403): the secret was rotated, the app deleted, or sandbox credentials are set on a live store. developer.paypal.com → Apps & Credentials → **Live** → the store's app → copy the Client ID and Secret into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. |

Nothing is written on a 424, and a consumer should keep what it already has for that provider.
Stripe lines cost one Stripe request per page: each row's source, and a refund's or dispute's
charge, come expanded in that request. Expanding the charge needs **Charges: Read**; a key without
it gets the lines anyway (one retry without the charge), and a refund or dispute whose charge is
not on the same page comes back with `order_id: null` instead of failing.

## Errors

`401 unauthorized` (missing/wrong key) · `404 not_found` · `422 validation_failed` (with
`details` per field) · `409 conflict` (e.g. cancelling a fulfilled order) · `400 invalid_grant` (code
exchange) · `429 rate_limited` (repeated sign-in or exchange failures from one address) ·
`424 processor_permission_missing` (payouts: the processor refused the store's key; `details`
names the provider and permission).
