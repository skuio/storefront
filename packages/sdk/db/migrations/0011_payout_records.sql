-- Payouts recorded the first time the Store API serves them as `paid` (replaces 0010's
-- payout_line_assignments, which never shipped in a release). A recorded payout is served from here
-- from then on, so its lines and their order never change even when the processor's own data would
-- now group or order a transaction differently (PayPal reports an eCheck's settlement only through
-- transaction_updated_date, which a later refund also moves).
--
-- Keyed by provider, the processor account (`account_id`: an account switch never collides with the
-- old account's records) and `scope` (the adapter's grouping: PayPal `withdrawal` or `balance` mode).
-- `payout_records` is the finalization marker: a request inserts it with its own `token`, and only the
-- request whose token is there writes the lines, in the same batch, so two concurrent first reads
-- cannot both record. `payout_record_lines` is every line in served order (`position`), including
-- computed lines such as carry lines (`transaction_id` NULL); a transaction is in at most one recorded
-- payout per provider, account and scope. Deleting a payout's rows (its withdrawal was reversed)
-- frees its transactions for the next payout.
DROP TABLE IF EXISTS payout_line_assignments;

CREATE TABLE payout_records (
  provider     TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  scope        TEXT NOT NULL,
  payout_id    TEXT NOT NULL,
  token        TEXT NOT NULL,
  payout_json  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (provider, account_id, scope, payout_id)
);

CREATE TABLE payout_record_lines (
  provider        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  scope           TEXT NOT NULL,
  payout_id       TEXT NOT NULL,
  position        INTEGER NOT NULL,
  transaction_id  TEXT NULL,
  occurred_at     TEXT NULL,
  line_json       TEXT NOT NULL,
  PRIMARY KEY (provider, account_id, scope, payout_id, position),
  UNIQUE (provider, account_id, scope, transaction_id)
);
CREATE INDEX payout_record_lines_by_time ON payout_record_lines (provider, account_id, scope, occurred_at);
