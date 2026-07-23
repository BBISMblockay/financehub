-- Backfill products_master's merchandising columns from the old product_tags
-- spreadsheet import (443 rows, matched by product_title -- product_tags has
-- no SKU). Applied product-level: every products_master SKU row sharing a
-- matched title gets the same values, since tags/category are a per-product
-- concept, not per-SKU.
--
-- category/notes map directly onto products_master's existing columns.
-- product_tags carried more dimensions than the simplified schema
-- (collection, indicator_group, primary_color, artwork_side, sub_tag) --
-- those don't have a dedicated column anymore, so a new `attributes` jsonb
-- column holds them for future use instead of being dropped on the floor.
-- Only fills currently-blank category/notes -- never overwrites anything
-- already set through the new Catalog tab.
-- Safe to re-run.

alter table public.products_master
  add column if not exists attributes jsonb not null default '{}'::jsonb;

with legacy as (
  select
    lower(trim(product_title)) as norm_title,
    (array_agg(product_category order by uploaded_at desc nulls last) filter (where product_category is not null and product_category <> ''))[1] as product_category,
    (array_agg(notes           order by uploaded_at desc nulls last) filter (where notes is not null and notes <> ''))[1] as notes,
    (array_agg(collection      order by uploaded_at desc nulls last) filter (where collection is not null and collection <> ''))[1] as collection,
    (array_agg(indicator_group order by uploaded_at desc nulls last) filter (where indicator_group is not null and indicator_group <> ''))[1] as indicator_group,
    (array_agg(primary_color   order by uploaded_at desc nulls last) filter (where primary_color is not null and primary_color <> ''))[1] as primary_color,
    (array_agg(artwork_side    order by uploaded_at desc nulls last) filter (where artwork_side is not null and artwork_side <> ''))[1] as artwork_side,
    (array_agg(sub_tag         order by uploaded_at desc nulls last) filter (where sub_tag is not null and sub_tag <> ''))[1] as sub_tag
  from public.product_tags
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  group by 1
)
update public.products_master pm
set
  category = coalesce(pm.category, legacy.product_category),
  notes = coalesce(pm.notes, legacy.notes),
  attributes = pm.attributes || jsonb_strip_nulls(jsonb_build_object(
    'legacy_collection', legacy.collection,
    'legacy_indicator_group', legacy.indicator_group,
    'legacy_primary_color', legacy.primary_color,
    'legacy_artwork_side', legacy.artwork_side,
    'legacy_sub_tag', legacy.sub_tag
  ))
from legacy
where pm.company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
  and lower(trim(pm.product_title)) = legacy.norm_title;
