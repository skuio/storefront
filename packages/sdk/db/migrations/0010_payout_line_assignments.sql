-- Which payout a processor transaction belongs to, recorded the first time the Store API serves that
-- payout as `paid` (GET /payouts/{provider}/{id} or its lines). Later reads honour the record, so a
-- paid payout's lines never change even when the processor's own data would now group a transaction
-- differently (PayPal reports an eCheck's settlement only through transaction_updated_date, which a
-- later refund also moves). `scope` is the adapter's grouping (PayPal: `withdrawal` or `balance` mode).
-- A transaction is in at most one payout per provider and scope; the first record wins.
-- `occurred_at` is the transaction's own time (ISO 8601 UTC with ms), so a read finds the records of
-- the transactions it fetched with one range query.
CREATE TABLE payout_line_assignments (
  provider        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  payout_id       TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  assigned_at     TEXT NOT NULL,
  PRIMARY KEY (provider, scope, transaction_id)
);
CREATE INDEX payout_line_assignments_by_time ON payout_line_assignments (provider, scope, occurred_at);
