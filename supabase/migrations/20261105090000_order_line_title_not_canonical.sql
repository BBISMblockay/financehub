-- A bot asked how many of a product sold should not get a split answer.
--
-- The catalog fix for `products_master.product_title` (20261105080000) means a
-- bot joining `sales_by_day` to `products_master`, or reading
-- `sales_by_product_title_daily_v`, now gets ONE row per product. One route
-- still splits it: grouping `shopify_order_lines.title`, which is each store's
-- own wording AT THE TIME OF SALE. For the youth hoodie this returns the
-- storefront wording and the wholesale word-order as two products.
--
-- And the catalog actively invited that query. `shopify_order_lines`'s
-- description said the title was "reliable even where SKUs are shared across
-- products", which is true of the thing it was written for -- telling two
-- products apart when they share a SKU -- and exactly wrong for the opposite
-- question, telling one product's own lines apart from each other.
--
-- Nothing is rewritten in the data: an order line's title is what the customer
-- was shown and must stay that way. This is catalog TEXT only, which is what
-- `describe_tables` serves to every MCP bot and to Ask SILO, so the guidance
-- reaches them without a deploy.
--
-- Idempotent and safe to re-apply.

update public.silo_chat_schema_catalog
   set description = replace(
         description,
         'title is the as-sold line-item title, reliable even where SKUs are shared across products.',
         'title is the as-sold line-item title: the wording the SELLING STORE used at the time of sale. '
         || 'It tells two products apart where they share a SKU, and it must NOT be grouped to count a '
         || 'product: the same product carried in two stores sells under each store''s own wording, so '
         || 'grouping this column splits one product into several. To count or rank products use '
         || 'sales_by_product_title_daily_v (one canonical title per product), or group by sku here and '
         || 'join products_master for the title.'),
       updated_at = now()
 where relname = 'shopify_order_lines';

update public.silo_chat_schema_catalog
   set description = description
         || ' product_title is ONE canonical title per (company, sku) -- the published store''s copy, '
         || 'kept current by the Shopify sync -- so it is safe to group by, and it is the title every '
         || 'SILO report shows. An order line''s own title may differ from it, because that is the '
         || 'selling store''s wording at the time of sale.',
       updated_at = now()
 where relname = 'products_master'
   and description not like '%ONE canonical title per (company, sku)%';

-- Prove both landed, and that the sentence that invited the bad query is gone.
do $$
declare
  ol text;
  pm text;
begin
  select description into ol from public.silo_chat_schema_catalog where relname = 'shopify_order_lines';
  select description into pm from public.silo_chat_schema_catalog where relname = 'products_master';

  if ol is null then
    raise exception 'shopify_order_lines is not in silo_chat_schema_catalog';
  end if;
  if ol like '%reliable even where SKUs are shared across products.%' then
    raise exception 'the shopify_order_lines title sentence was not replaced; the catalog still tells bots to group by it';
  end if;
  if ol not like '%splits one product into several%' then
    raise exception 'the shopify_order_lines warning is missing';
  end if;

  if pm is null then
    raise exception 'products_master is not in silo_chat_schema_catalog';
  end if;
  if pm not like '%ONE canonical title per (company, sku)%' then
    raise exception 'the products_master canonical-title note is missing';
  end if;
end $$;
