-- Store platform schema. Applied with `wrangler d1 migrations apply <db>` (add --local for dev).
-- Timestamps are ISO-8601 UTC strings; money is integer minor units + ISO currency.

CREATE TABLE categories (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  parent_id        TEXT NULL,
  description_html TEXT NULL,
  image_url        TEXT NULL,
  image_alt        TEXT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX categories_parent ON categories (parent_id);

CREATE TABLE products (
  sku                    TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  description_html       TEXT NULL,
  short_description_html TEXT NULL,
  price_amount           INTEGER NOT NULL,
  currency               TEXT NOT NULL,
  compare_at_amount      INTEGER NULL,
  attributes_json        TEXT NOT NULL DEFAULT '{}',
  active                 INTEGER NOT NULL DEFAULT 1,
  position               INTEGER NOT NULL DEFAULT 0,
  legacy_path            TEXT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX products_active ON products (active, position);

CREATE TABLE product_categories (
  sku         TEXT NOT NULL REFERENCES products (sku) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sku, category_id)
);
CREATE INDEX product_categories_category ON product_categories (category_id);

CREATE TABLE product_images (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sku      TEXT NOT NULL REFERENCES products (sku) ON DELETE CASCADE,
  url      TEXT NOT NULL,
  alt      TEXT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX product_images_sku ON product_images (sku, position);

-- A row means the SKU is tracked. No row = not tracked = always purchasable.
CREATE TABLE inventory (
  sku             TEXT PRIMARY KEY REFERENCES products (sku) ON DELETE CASCADE,
  available       INTEGER NOT NULL DEFAULT 0,
  allow_backorder INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NULL,
  phone      TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE magic_links (
  token_hash  TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX magic_links_customer ON magic_links (customer_id);

CREATE TABLE customer_sessions (
  token_hash   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX customer_sessions_customer ON customer_sessions (customer_id);

CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  number                INTEGER NOT NULL UNIQUE,
  status                TEXT NOT NULL,
  payment_status        TEXT NOT NULL DEFAULT 'unpaid',
  payment_provider      TEXT NULL,
  payment_reference     TEXT NULL,
  payment_method_label  TEXT NULL,
  paid_at               TEXT NULL,
  currency              TEXT NOT NULL,
  subtotal              INTEGER NOT NULL,
  shipping              INTEGER NOT NULL DEFAULT 0,
  tax                   INTEGER NOT NULL DEFAULT 0,
  discount              INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL,
  customer_id           TEXT NOT NULL REFERENCES customers (id),
  email                 TEXT NOT NULL,
  shipping_address_json TEXT NOT NULL,
  billing_address_json  TEXT NULL,
  shipping_method_code  TEXT NULL,
  shipping_method_name  TEXT NULL,
  external_reference    TEXT NULL,
  notes                 TEXT NULL,
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  access_key            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cancelled_at          TEXT NULL
);
CREATE INDEX orders_updated ON orders (updated_at, id);
CREATE INDEX orders_customer ON orders (customer_id, created_at);
CREATE INDEX orders_payment_reference ON orders (payment_provider, payment_reference);
CREATE INDEX orders_status ON orders (status);

CREATE TABLE order_lines (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku                TEXT NOT NULL,
  name               TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  unit_amount        INTEGER NOT NULL,
  total_amount       INTEGER NOT NULL,
  fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
  image_url          TEXT NULL,
  position           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX order_lines_order ON order_lines (order_id, position);

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  reference    TEXT NULL,
  status       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  method_label TEXT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX payments_order ON payments (order_id);

CREATE TABLE fulfillments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  carrier         TEXT NULL,
  service         TEXT NULL,
  tracking_number TEXT NULL,
  tracking_url    TEXT NULL,
  shipped_at      TEXT NULL,
  notified_at     TEXT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (order_id, external_id)
);

CREATE TABLE fulfillment_lines (
  fulfillment_id TEXT NOT NULL REFERENCES fulfillments (id) ON DELETE CASCADE,
  sku            TEXT NOT NULL,
  quantity       INTEGER NOT NULL,
  PRIMARY KEY (fulfillment_id, sku)
);

CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data_json  TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX order_events_order ON order_events (order_id, id);
