-- Quotes (request for quote): a buyer — signed in or a guest who never makes an account — asks for a price on a
-- list of products; the operations system prices it through the Store API; the buyer accepts it, which places an
-- order at exactly the quoted prices, or declines it. Money is integer minor units; the priced columns stay NULL
-- until an offer exists.
CREATE TABLE quotes (
  id                    TEXT PRIMARY KEY,
  number                INTEGER NOT NULL UNIQUE,
  status                TEXT NOT NULL,          -- requested | quoted | accepted | declined | expired | cancelled
  customer_id           TEXT NOT NULL REFERENCES customers (id),
  email                 TEXT NOT NULL,
  company               TEXT NULL,
  message               TEXT NULL,
  shipping_address_json TEXT NULL,
  currency              TEXT NOT NULL,
  subtotal              INTEGER NULL,
  shipping              INTEGER NULL,
  tax                   INTEGER NULL,
  total                 INTEGER NULL,
  offer_note            TEXT NULL,
  expires_at            TEXT NULL,
  external_reference    TEXT NULL,
  order_id              TEXT NULL REFERENCES orders (id),
  decline_reason        TEXT NULL,
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  access_key            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  quoted_at             TEXT NULL,
  accepted_at           TEXT NULL,
  declined_at           TEXT NULL,
  cancelled_at          TEXT NULL
);
CREATE INDEX quotes_updated ON quotes (updated_at, id);
CREATE INDEX quotes_customer ON quotes (customer_id, created_at);
CREATE INDEX quotes_email ON quotes (email, created_at);
CREATE INDEX quotes_status ON quotes (status, expires_at);

CREATE TABLE quote_lines (
  id           TEXT PRIMARY KEY,
  quote_id     TEXT NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  sku          TEXT NOT NULL,
  name         TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  list_amount  INTEGER NULL,   -- the catalog price when the buyer asked; for reference only
  unit_amount  INTEGER NULL,   -- the offered price; NULL until quoted
  total_amount INTEGER NULL,
  image_url    TEXT NULL,
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX quote_lines_quote ON quote_lines (quote_id, position);

CREATE TABLE quote_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id   TEXT NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data_json  TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX quote_events_quote ON quote_events (quote_id, id);
