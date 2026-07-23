-- Historical catch-up for the two-way Launch <-> Pipeline link (#300).
-- The link only forms on save, so rows created before it shipped never
-- paired: existing launch products had no product_tracker_id, and Pipeline
-- items linked to a launch were invisible on that launch's Products tab.
--   Part 1: pair existing launch products with Pipeline items by title
--           (same launch preferred).
--   Part 2: create the missing launch-side row for every Pipeline item
--           that is linked to a launch but absent from its Products tab.
-- Safe to re-run (both parts are no-ops once paired).

update public.launch_product_readiness r
set product_tracker_id = t.id
from public.product_tracker t
where r.product_tracker_id is null
  and lower(trim(t.product_title)) = lower(trim(r.product_title))
  and (t.launch_id = r.launch_id or t.launch_id is null);

insert into public.launch_product_readiness (
  product_title, product_type, manufacturer, vendor_name, factory_id,
  bulk_eta, expected_units, launch_id, product_tracker_id,
  readiness_status, product_shot_status, copy_status, company_entity_id
)
select
  t.product_title, t.product_type, t.manufacturer, t.manufacturer, t.factory_id,
  t.bulk_eta, t.expected_units, t.launch_id, t.id,
  'not_reviewed', 'not_started', 'not_started', t.company_entity_id
from public.product_tracker t
where t.launch_id is not null
  and not exists (select 1 from public.launch_product_readiness r where r.product_tracker_id = t.id)
  and not exists (
    select 1 from public.launch_product_readiness r
    where r.launch_id = t.launch_id
      and lower(trim(r.product_title)) = lower(trim(t.product_title))
  );
