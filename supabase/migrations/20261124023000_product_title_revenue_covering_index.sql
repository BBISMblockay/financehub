-- Top Products by Revenue aggregates a bounded date window over the existing
-- product-title rollup. Keep its filtering and money semantics unchanged.
-- The existing tenant/day index still needs heap reads for title and net sales.
-- This narrower, merchandise-only covering index permits index-only reads
-- when visibility allows. Keep the general date index for other consumers.
create index if not exists sales_by_product_title_daily_mv_rank_idx
  on public.sales_by_product_title_daily_mv (company_entity_id, day_date)
  include (product_title, net_sales)
  where product_title <> 'x-redo';
