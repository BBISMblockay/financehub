-- The legacy product_tags backfill (20260723190000) put collection/color/
-- indicator_group/artwork_side/sub_tag values into products_master's new
-- attributes jsonb column, but nothing in the Catalog tab surfaces that
-- column -- it was invisible in the UI even though the data existed.
-- Fold those values into tags[] too so they actually show up (Catalog's
-- Tags column/filter/search all already work off tags[]). attributes is
-- left as-is as the structured record.
-- Safe to re-run (dedupes via array_agg(distinct ...)).

update public.products_master pm
set tags = (
  select array_agg(distinct t) from unnest(
    pm.tags || array_remove(ARRAY[
      pm.attributes->>'legacy_collection',
      pm.attributes->>'legacy_primary_color',
      pm.attributes->>'legacy_indicator_group',
      pm.attributes->>'legacy_artwork_side',
      pm.attributes->>'legacy_sub_tag'
    ], NULL)
  ) as t
)
where pm.attributes <> '{}'::jsonb;
