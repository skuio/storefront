-- What the payment processor actually captured for an order and what it kept (its fee), so an
-- operations system reads them from the Store API (`payment.amount_received`, `fee`, `net`,
-- `transaction_id`, `fee_reported_at`) instead of calling the processor itself. Recorded by the
-- Stripe and PayPal adapters when they confirm a payment, or lazily on GET /orders/{id}.
-- Each amount is integer minor units with its own currency: the fee and net are in the processor's
-- settlement currency (Stripe balance transaction, PayPal receivable), which may differ from the order's.
ALTER TABLE orders ADD COLUMN payment_amount_received INTEGER NULL;
ALTER TABLE orders ADD COLUMN payment_amount_received_currency TEXT NULL;
ALTER TABLE orders ADD COLUMN payment_fee INTEGER NULL;
ALTER TABLE orders ADD COLUMN payment_fee_currency TEXT NULL;
ALTER TABLE orders ADD COLUMN payment_net INTEGER NULL;
ALTER TABLE orders ADD COLUMN payment_net_currency TEXT NULL;
ALTER TABLE orders ADD COLUMN payment_transaction_id TEXT NULL;
ALTER TABLE orders ADD COLUMN payment_fee_reported_at TEXT NULL;
