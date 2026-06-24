-- Index to make inventory_on_hand purge fast before each Shopify snapshot.
-- Without this, DELETE by (company_entity_id, shop_domain, source) times out on large tables.
create index if not exists inventory_on_hand_shopify_purge_idx
  on public.inventory_on_hand (company_entity_id, shop_domain, source)
  where source = 'shopify_api';
