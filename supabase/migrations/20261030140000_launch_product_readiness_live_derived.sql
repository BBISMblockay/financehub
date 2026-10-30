-- Launch product readiness: derive "is it live", because nothing writes it.
--
-- launch_product_readiness carries six status columns. Exactly three of them
-- have a writer anywhere in the codebase -- readiness_status,
-- product_shot_status and copy_status, from the Launch Calendar's product form
-- (v2/launch-calendar.html getProductPayload). The other three --
-- live_status, on_hand_status and website_status -- are set to their default
-- at insert (v2/products.html, v2/launch-calendar.html and the two Product
-- Studio RPCs) and are never updated by any surface. They are not stale; they
-- have never been written.
--
-- Measured on production 2026-10-30, all 224 Baseballism rows:
--
--   live_status         'not_live'      224 of 224
--   on_hand_status      'unknown'       224 of 224
--   website_status      'not_started'   224 of 224
--
-- live_status is the one that does real damage, because it is confidently
-- wrong rather than merely blank: 46 of those products are published and
-- active in the catalog right now. Ask a report or an MCP connection "what is
-- live for this launch" and the honest-looking answer is "nothing", including
-- for 46 products currently selling. A human on the launch page knows to
-- ignore the column. A bot reading the table cannot.
--
-- Nobody is going to hand-maintain a live flag for 224 products, and they
-- should not have to: SILO already knows the answer from the catalog. So this
-- derives it rather than asking for data entry.
--
-- Resolution is by product_title against products_master, the same key
-- launch_product_actuals_v already uses (20260826080000) and the same index --
-- products_master is variant-grained and product_title IS the product
-- identity in this schema. Reusing that resolver rather than inventing a
-- second one matters: the two must never disagree about which catalog product
-- a launch row means.
--
-- Three states, and the third is the point:
--
--   live        resolved, and at least one variant is published AND active
--   not_live    resolved, and no variant is both
--   unknown     the title does not resolve to the catalog at all
--
-- 'unknown' is 89 of the 224 rows. Collapsing it into 'not_live' -- which is
-- what the stored column does today -- is the "blank is not zero" mistake:
-- a title that does not match the catalog tells you nothing about whether the
-- product is live, and must not be reported as evidence that it isn't.
--
-- Measured split: 46 live, 89 not_live, 89 unknown.
--
-- The stored column is left in place and untouched. Something may yet grow a
-- writer for it, and rewriting 224 rows to a derived value would make a
-- derived number look like a recorded one.
--
-- security_invoker, like every other view here, so RLS decides what a reader
-- sees. One consequence worth knowing: products_master is read as the caller,
-- so a reader whose policies do not reach the catalog resolves nothing and
-- gets 'unknown' rather than 'not_live'. That is the honest answer -- they
-- cannot see the evidence either way -- and it is the reason the third state
-- has to exist rather than defaulting to 'not_live'.

begin;

create or replace view public.launch_product_readiness_v
with (security_invoker = true) as
with resolved as (
  select
    r.id as readiness_id,
    count(pm.sku)                                                          as catalog_variants,
    count(*) filter (
      where pm.online_published_at is not null and pm.shopify_status = 'active'
    )                                                                      as live_variants,
    min(pm.online_published_at) filter (
      where pm.shopify_status = 'active'
    )                                                                      as first_published_at
  from public.launch_product_readiness r
  left join public.products_master pm
    on lower(btrim(pm.product_title)) = lower(btrim(r.product_title))
   and pm.company_entity_id = r.company_entity_id
  group by r.id
)
select
  r.id,
  r.company_entity_id,
  r.launch_id,
  r.product_tracker_id,
  r.factory_id,
  r.product_title,
  r.product_type,
  r.collection_name,
  r.manufacturer,
  r.po_number,
  r.vendor_name,
  r.bulk_eta,
  r.expected_units,
  r.expected_retail_value,
  r.on_hand_status,
  r.size_requests,
  r.sizes_ready,
  r.sizes_picked_up,
  r.product_shot_status,
  r.copy_status,
  r.website_status,
  r.readiness_status,
  r.notes,
  r.created_at,
  r.updated_at,
  r.created_by,
  -- The derived answer. This is what a consumer asking a view for
  -- "live_status" wants, which is why it carries the plain name.
  case
    when d.catalog_variants = 0 then 'unknown'
    when d.live_variants > 0    then 'live'
    else 'not_live'
  end                                           as live_status,
  (d.live_variants > 0)                         as is_live,
  (d.catalog_variants > 0)                      as is_resolved,
  d.catalog_variants,
  d.live_variants,
  d.first_published_at,
  -- The raw column, kept reachable and named for what it is.
  r.live_status                                 as live_status_stored
from public.launch_product_readiness r
join resolved d on d.readiness_id = r.id;

comment on view public.launch_product_readiness_v is
  'launch_product_readiness with live_status DERIVED from the catalog instead of read from the '
  'unwritten stored column. live_status is live / not_live / unknown: resolved by product_title '
  'to products_master (the same key launch_product_actuals_v uses), live when any variant is '
  'published and active, unknown when the title does not resolve -- unknown is NOT not_live. '
  'live_status_stored is the raw column, which no surface writes. See 20261030140000.';

-- ── Tell the model what it is reading ──────────────────────────────────────
-- A new view has to enter Ask SILO's / the MCP connection's catalog before it
-- can be described, and the stored columns need a warning either way: the
-- table stays reachable, so a bot can still read live_status off it.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['launch readiness','readiness','launch prep','go live','is it live',
                   'live products','launch products','published'],
  description = $d$launch_product_readiness with live_status DERIVED from the catalog -- USE THIS, not the base table, for anything about whether a launch's products are live or ready. live_status here takes three values: 'live' (resolved to products_master and at least one variant is published and active), 'not_live' (resolved, nothing published), and 'unknown' (the product_title does not match the catalog, so there is NO evidence either way -- never report unknown as not live). is_live, is_resolved, catalog_variants, live_variants and first_published_at carry the same answer in parts. live_status_stored is the base table's own column, which nothing writes. Product identity is product_title (products_master is variant-grained); join launches through launch_id to launch_calendar, whose name column is title.$d$
where relname = 'launch_product_readiness_v';

-- The base table is already in the report builder's allowlist
-- (20260902110000), so the fixed version of it belongs there too -- otherwise
-- a saved report or dashboard tile can only reach the broken column. New
-- objects default to false, so this has to be explicit.
-- The column is `reportable` (and `report_priority`), not `is_reportable` --
-- checked against production, not inferred from the flag's name.
-- report_priority 1 like launch_product_actuals_v, the other derived launch
-- view: it should be offered above the raw table it corrects.
update public.silo_chat_schema_catalog set
  reportable = true,
  report_priority = 1
where relname = 'launch_product_readiness_v';

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ UNWRITTEN COLUMNS -- READ BEFORE QUOTING A STATUS: of the six status columns here, only readiness_status, product_shot_status and copy_status have a writer (the Launch Calendar product form). live_status, on_hand_status and website_status are set to their default on insert and are never updated by any surface, so on 2026-10-30 all 224 rows read live_status 'not_live', on_hand_status 'unknown' and website_status 'not_started' -- including 46 products that are published and selling. Do NOT answer "what is live/ready" from those three: use launch_product_readiness_v, whose live_status is derived from the catalog. readiness_status is a human judgement and is genuinely 'not_reviewed' when nobody has reviewed it, which is most rows -- say "not reviewed", not "not ready".$d$
where relname = 'launch_product_readiness'
  and coalesce(description, '') not like '%UNWRITTEN COLUMNS -- READ BEFORE QUOTING A STATUS%';

commit;
