-- Abandoned processor checkouts are expired lazily (orders.expireAbandoned), which
-- scans pending orders by age; this index keeps that scan cheap.
CREATE INDEX orders_status_created ON orders (status, created_at);
