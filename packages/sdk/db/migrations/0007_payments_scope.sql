-- Recording a payment (PATCH /orders/{id} with `payment`) became its own scope, `payments`.
-- Until now the `orders` scope covered it, and the approval screen said so ("Read orders,
-- record payments and cancellations"), so every connection already approved for `orders`
-- keeps that power. New connections must ask for `payments` explicitly.
UPDATE connections
SET scopes_json = json_insert(scopes_json, '$[#]', 'payments')
WHERE EXISTS (SELECT 1 FROM json_each(connections.scopes_json) WHERE value = 'orders')
  AND NOT EXISTS (SELECT 1 FROM json_each(connections.scopes_json) WHERE value = 'payments');
