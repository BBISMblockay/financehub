-- Populate products_master.subcategory/department from the retired
-- product_tags book's genuinely hand-curated dimensions (title-matched,
-- blanks only). Deliberately NOT the legacy product_category column -- that
-- vocab mirrors Shopify's product_type ("T-Shirts", "Cap"), which already
-- drives category. The fields with real curation:
--   subcategory <- collection      ("Field of Dreams", "Ken Griffey Jr.", ...)
--   department  <- indicator_group ("Core", "License", "MLB", "Brand-Pillar", ...)
-- Both stay user-editable in the Catalog tab; the Shopify sync never
-- writes either column.
-- Safe to re-run.

with legacy as (
  select
    lower(trim(product_title)) as norm_title,
    (array_agg(collection order by uploaded_at desc nulls last) filter (where collection is not null and collection <> ''))[1] as collection,
    (array_agg(indicator_group order by uploaded_at desc nulls last) filter (where indicator_group is not null and indicator_group <> ''))[1] as indicator_group
  from public.product_tags
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  group by 1
)
update public.products_master pm
set subcategory = coalesce(pm.subcategory, l.collection),
    department  = coalesce(pm.department, l.indicator_group)
from legacy l
where pm.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and lower(trim(pm.product_title)) = l.norm_title
  and (pm.subcategory is null or pm.department is null);
