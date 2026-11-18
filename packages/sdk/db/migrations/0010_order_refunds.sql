-- Refunds through the Store API (POST /orders/{id}/refunds, scope `refunds`) and refunds the
-- processor reports (made in the Stripe or PayPal dashboard: `source = 'processor'`).
-- Amounts are integer minor units in the order currency. A `pending` or `succeeded` row counts
-- against what can still be refunded; the insert that reserves an amount checks that sum in the
-- same statement, so two concurrent requests cannot refund more than was received.
CREATE TABLE IF NOT EXISTS order_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  shipping INTEGER NULL,
  lines_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NULL,
  note TEXT NULL,
  provider TEXT NOT NULL,
  reference TEXT NULL,
  failure_reason TEXT NULL,
  idempotency_key TEXT NOT NULL,
  source TEXT NOT NULL,
  notify_customer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_reference ON order_refunds (provider, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refunds_order ON order_refunds (order_id, created_at);
