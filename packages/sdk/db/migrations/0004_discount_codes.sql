-- Discount codes the store prices itself, and the partner they attribute the order to.
-- partner_commission is snapshotted when the order is placed, so changing a code's rate never rewrites history.
ALTER TABLE orders ADD COLUMN discount_code TEXT NULL;
ALTER TABLE orders ADD COLUMN discount_partner TEXT NULL;
ALTER TABLE orders ADD COLUMN partner_commission INTEGER NOT NULL DEFAULT 0;
CREATE INDEX orders_discount_partner ON orders (discount_partner, created_at);
