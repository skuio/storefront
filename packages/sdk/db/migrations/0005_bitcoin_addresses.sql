-- On-chain bitcoin payments watched from a hardware wallet's account xpub (payments/bitcoin.ts).
-- One row per derived receive address. An address is quoted to one order at a time; an expired quote
-- whose address never saw a transaction is recycled, so abandoned checkouts don't burn through the
-- wallet's gap limit (Trezor Suite stops looking after 20 unused addresses).
CREATE TABLE bitcoin_addresses (
  derivation_index INTEGER PRIMARY KEY,
  address          TEXT NOT NULL UNIQUE,
  order_id         TEXT NULL REFERENCES orders (id),
  amount_sats      INTEGER NULL,
  btc_usd_rate     REAL NULL,
  quoted_at        TEXT NULL,
  expires_at       TEXT NULL,
  txid             TEXT NULL,
  received_sats    INTEGER NOT NULL DEFAULT 0,
  paid_at          TEXT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX bitcoin_addresses_order ON bitcoin_addresses (order_id);
CREATE INDEX bitcoin_addresses_open ON bitcoin_addresses (paid_at, expires_at);
