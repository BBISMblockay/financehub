-- Which locations count as which sales CHANNEL, per company.
--
-- Every Marketing RPC scoped itself to the online store with a hardcoded
-- `location_tag = 'online'`. That is drift from this repo's own stated rule
-- (CLAUDE.md names `locations.store_type = 'online'` as the definition) and it
-- works only because Baseballism happened to name their online location
-- "online". Measured 2026-09-20 across the three live tenants:
--
--   Baseballism    27 locations: 1 online, 26 retail, 1 wholesale
--   Test Company    2 locations: 0 online, 2 retail   <- genuinely no online
--                                                        store; an empty
--                                                        online scope is the
--                                                        CORRECT answer
--   BlockayOps      0 locations at all
--
-- So for a second tenant the literal does not merely return the wrong rows,
-- it returns NO rows, and a Marketing page reads that as a quiet week rather
-- than as a misconfiguration.
--
-- WHY NO NEW TABLE. A first draft of this added a `location_channel_map`
-- keyed on location_tag, on the belief that nothing maintained
-- `locations.store_type` -- true of the Shopify sync, which only READS
-- `locations` for id mapping, but NOT true of the app: /v2/integrations.html's
-- location mapper has written store_type from a constrained select
-- ('online','retail','outlet','pop_up','warehouse','wholesale') all along.
-- A new table would have been a SECOND admin control for one fact, which is
-- the same drift this migration exists to remove. store_type stays the single
-- source of truth; what was missing is a named way to READ it as a channel.
--
-- An empty result is "no such channel configured", NEVER zero sales. See
-- wow_channel_status() at the bottom -- callers must be able to tell the two
-- apart, and the Marketing pages render the difference.

-- ---------------------------------------------------------------------------
-- silo_location_slug: the ONE definition of how a locations row becomes a tag
-- ---------------------------------------------------------------------------
-- This expression is currently inlined by hand in v_marketing_mer_daily, the
-- ownership reports and one report tie-out. Naming it lets those three be
-- reconciled onto one definition instead of three copies that drift -- the
-- same reasoning as normalize_merchant(). It reproduces the sync's slugify()
-- exactly: lowercase, non-alphanumeric runs -> '_', trim '_'.
create or replace function public.silo_location_slug(p_text text)
returns text
language sql
immutable
as $fn$
  select nullif(btrim(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '_', 'g'), '_'), '');
$fn$;

comment on function public.silo_location_slug(text) is
  'Slugify a location code/name into a sales_by_day.location_tag. Mirrors slugify() in scripts/lib/shopify-sync-core.mjs; changing one without the other silently stops locations matching sales rows.';


-- ---------------------------------------------------------------------------
-- silo_location_channel: store_type vocabulary -> reporting channel
-- ---------------------------------------------------------------------------
-- Forgiving on the way IN, exact on the way OUT. The Integrations select emits
-- six values; older rows and test fixtures across this repo also carry 'ecom',
-- 'Ecom', 'Retail', 'b2b' and 'pos'. NULL means UNCLASSIFIED -- a real answer,
-- surfaced for a person to fix, and deliberately not folded into 'other',
-- which would make "nobody has said" look like "somebody said none of these".
create or replace function public.silo_location_channel(p_store_type text)
returns text
language sql
immutable
as $fn$
  select case lower(btrim(coalesce(p_store_type, '')))
    when 'online'      then 'online'
    when 'ecom'        then 'online'
    when 'e-commerce'  then 'online'
    when 'web'         then 'online'
    when 'retail'      then 'retail'
    when 'outlet'      then 'retail'
    when 'pop_up'      then 'retail'
    when 'popup'       then 'retail'
    when 'store'       then 'retail'
    when 'pos'         then 'retail'
    when 'wholesale'   then 'wholesale'
    when 'b2b'         then 'wholesale'
    when 'warehouse'   then 'other'
    else null
  end;
$fn$;

comment on function public.silo_location_channel(text) is
  'locations.store_type -> reporting channel (online/retail/wholesale/other). NULL = unclassified, which is a real answer and never silently "other".';


-- ---------------------------------------------------------------------------
-- silo_channel_location_tags: what every channel-scoped report resolves through
-- ---------------------------------------------------------------------------
-- Returns text[] rather than a set on purpose. A set-returning function in a
-- WHERE clause carries the planner's default 1000-row estimate -- the trap
-- wow_window() needed ROWS 1 for, which took wow_kpi_compare from sub-second
-- to timing out. A STABLE scalar returning an array is evaluated once, and
-- `location_tag = any(...)` still uses the btree indexes on
-- (company_entity_id, location_tag, day_date).
--
-- SECURITY INVOKER (the default): `locations` RLS scopes the read to the
-- caller's active company, so this needs no definer rights and cannot widen.
-- Never returns NULL -- an unconfigured channel is an EMPTY array, so
-- `= any(...)` matches nothing rather than evaluating to NULL.
--
-- Deliberately NOT filtered on is_active. A closed store's history is still
-- retail revenue; excluding it would quietly drop that history out of every
-- channel total the day somebody unticks the box.
create or replace function public.silo_channel_location_tags(p_channel text)
returns text[]
language sql
stable
as $fn$
  select coalesce(array_agg(distinct x.tag), '{}'::text[])
  from (
    select public.silo_location_slug(coalesce(nullif(l.location_code, ''), l.location_name)) as tag
    from public.locations l
    where l.company_entity_id = public.active_company_id()
      and public.silo_location_channel(l.store_type) = lower(btrim(p_channel))
  ) x
  where x.tag is not null;
$fn$;

comment on function public.silo_channel_location_tags(text) is
  'The location_tags making up a channel for the active company, derived from locations.store_type. EMPTY means the channel is not configured -- never that it sold nothing. Readers must say which.';

revoke execute on function public.silo_location_slug(text)          from public, anon;
revoke execute on function public.silo_location_channel(text)       from public, anon;
revoke execute on function public.silo_channel_location_tags(text)  from public, anon;
grant  execute on function public.silo_location_slug(text)          to authenticated;
grant  execute on function public.silo_location_channel(text)       to authenticated;
grant  execute on function public.silo_channel_location_tags(text)  to authenticated;


-- ---------------------------------------------------------------------------
-- wow_channel_status: lets a page tell "not configured" from "sold nothing"
-- ---------------------------------------------------------------------------
-- A separate function rather than a new key inside wow_report() /
-- wow_data_through(): those are rewritten by string replacement against their
-- DEPLOYED bodies (see the companion migration), and surgery on a 200-line
-- jsonb_build_object is how a report silently loses a field. This is purely
-- additive and reads only `locations` plus the 138k-row rollup.
create or replace function public.wow_channel_status(p_channel text default 'online')
returns jsonb
language sql
stable
as $fn$
  with tags as (
    select public.silo_channel_location_tags(p_channel) as t
  ),
  sold as (
    select distinct d.location_tag
    from public.wow_sales_daily_type_v d
    where d.location_tag is not null
  ),
  classified as (
    select public.silo_location_slug(coalesce(nullif(l.location_code, ''), l.location_name)) as tag
    from public.locations l
    where l.company_entity_id = public.active_company_id()
      and public.silo_location_channel(l.store_type) is not null
  ),
  unclassified as (
    -- Locations that HAVE sales and no channel. This is the number a person
    -- can act on: every one is revenue no channel report counts.
    select coalesce(array_agg(s.location_tag order by s.location_tag), '{}'::text[]) as t
    from sold s
    where not exists (select 1 from classified c where c.tag = s.location_tag)
  )
  select jsonb_build_object(
    'channel',            lower(btrim(p_channel)),
    'configured',         cardinality(tags.t) > 0,
    'location_tags',      to_jsonb(tags.t),
    'location_tag_count', cardinality(tags.t),
    'unclassified_tags',  to_jsonb(unclassified.t),
    'unclassified_count', cardinality(unclassified.t)
  )
  from tags, unclassified;
$fn$;

comment on function public.wow_channel_status(text) is
  'Is this channel configured for the active company, and which sold-from locations are still unclassified. configured=false means the Marketing pages have nothing to scope to -- render that, never a zero.';

revoke execute on function public.wow_channel_status(text) from public, anon;
grant  execute on function public.wow_channel_status(text) to authenticated;


-- ---------------------------------------------------------------------------
-- THE SAFETY PROPERTY: this migration restates nobody's published numbers.
-- ---------------------------------------------------------------------------
-- The old code scoped to the literal tag 'online'. For every company, the set
-- this resolver derives must be exactly the set that literal matched --
-- otherwise the companion migration silently changes a number somebody has
-- already read. Computed per company by hand rather than through
-- active_company_id(), because a migration has no active company.
--
-- Measured 2026-09-20: Baseballism {online} = {online}; Test Company {} = {}
-- (two retail stores, no online store); BlockayOps {} = {} (no locations).
do $mig$
declare
  bad record;
begin
  for bad in
    select e.title,
           coalesce((select array_agg(distinct s.location_tag)
                       from public.sales_by_day s
                      where s.company_entity_id = e.id
                        and lower(btrim(s.location_tag)) = 'online'), '{}'::text[]) as old_set,
           coalesce((select array_agg(distinct public.silo_location_slug(
                                        coalesce(nullif(l.location_code, ''), l.location_name)))
                       from public.locations l
                      where l.company_entity_id = e.id
                        and public.silo_location_channel(l.store_type) = 'online'
                        and public.silo_location_slug(
                              coalesce(nullif(l.location_code, ''), l.location_name)) is not null),
                    '{}'::text[]) as new_set
    from public.entities e
    where e.entity_type = 'company'
  loop
    if bad.old_set <> bad.new_set then
      raise exception
        'location channel resolver: % would change the online scope from % to %. Refusing -- a scope change is a deliberate act in the Integrations location mapper, not a side effect of this migration.',
        bad.title, bad.old_set, bad.new_set;
    end if;
  end loop;

  raise notice 'location channel resolver: online scope verified unchanged for every company';
end;
$mig$;
