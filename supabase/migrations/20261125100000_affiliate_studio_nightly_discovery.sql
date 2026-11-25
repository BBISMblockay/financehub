-- Affiliate Studio: nightly Discovery, with its own on/off and limits, beside
-- the nightly Find (20261125040000). Blake 2026-11-25:
--
--   "in the toggle config for caps etc, we should allow toggle or input for
--    outward discovery not just customer research ... which should also run
--    at a schedule if on"
--   "we'd probably not spin our wheels and do modest amount if nightly etc,
--    then allow bigger on demand charged pulls. track the usage, bill it out.
--    if cap hit, require adjustment"
--
-- Still ONE Affiliate Studio bill: Discovery is metered under the same feature
-- ('affiliate_research'), and the monthly cap covers Find, Discovery, nightly
-- and on-demand alike. Nightly Discovery is OFF by default and modest when on
-- (10 creators, $1 a night). A press is never limited by the nightly figures.
--
-- This migration:
--   1. adds the Discovery settings to affiliate_studio_spend_settings
--   2. marks a nightly Discovery run (affiliate_discovery_runs.nightly), so
--      Billing can show the last one and the job can rotate programs
--   3. affiliate_studio_spend(): returns the new settings, and a run's own
--      spend now includes what an OPEN run has used so far (its held
--      reservations' recorded usage, at the customer price), so a nightly run
--      stops at its dollar limit while it is still going, not after
--   4. affiliate_studio_set_spend(): takes the Discovery settings (null = keep)
--   5. affiliate_studio_spend_summary(): adds the last nightly Discovery
--
-- Idempotent. No data is changed.

-- 1 ── Settings ──────────────────────────────────────────────────────────
alter table public.affiliate_studio_spend_settings
  add column if not exists discovery_nightly_enabled  boolean not null default false,
  add column if not exists discovery_night_creators   integer not null default 10,
  add column if not exists discovery_night_max_micros bigint  not null default 1000000;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_studio_spend_discovery_creators_chk') then
    alter table public.affiliate_studio_spend_settings add constraint affiliate_studio_spend_discovery_creators_chk
      check (discovery_night_creators between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_studio_spend_discovery_micros_chk') then
    alter table public.affiliate_studio_spend_settings add constraint affiliate_studio_spend_discovery_micros_chk
      check (discovery_night_max_micros > 0);
  end if;
end $$;

-- 2 ── Which Discovery runs the schedule started ─────────────────────────
alter table public.affiliate_discovery_runs add column if not exists nightly boolean not null default false;
comment on column public.affiliate_discovery_runs.nightly is
  'true = started by the nightly Discovery (affiliate-research nightly_discovery), not a person. 20261125100000.';

-- 3 ── The figure the page and the function share ────────────────────────
create or replace function public.affiliate_studio_spend(p_company uuid, p_scan uuid default null)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with b as (
    select (date_trunc('month', now() at time zone coalesce(public.silo_company_timezone(p_company), 'UTC'))
              at time zone coalesce(public.silo_company_timezone(p_company), 'UTC')) as month_start
  ), r as (
    select x.source_ref,
           case when x.enforced then x.charged_micros else coalesce(x.computed_charge_micros, 0) end as micros
      from public.ai_credit_reservations x, b
     where x.company_entity_id = p_company and x.feature = 'affiliate_research'
       and x.status = 'settled' and x.outcome = 'succeeded' and x.settled_at >= b.month_start
  ), open_run as (
    -- What a run still in progress has used so far (recorded by each step),
    -- at the customer price. Only for the one run asked about.
    select coalesce(sum(public.ai_credit_customer_micros(public.ai_credit_provider_cost(rt, x.usage), x.multiplier_bps)), 0) as micros
      from public.ai_credit_reservations x
      join public.ai_provider_rates rt on rt.id = x.rate_id
     where p_scan is not null and x.company_entity_id = p_company and x.feature = 'affiliate_research'
       and x.status = 'held' and x.source_ref = p_scan::text and x.usage is not null
  )
  select jsonb_build_object(
    'month_start', (select month_start from b),
    'month_micros', coalesce((select sum(micros) from r), 0),
    'scan_micros', case when p_scan is null then null
                        else coalesce((select sum(micros) from r where source_ref = p_scan::text), 0)
                             + (select micros from open_run) end,
    'nightly_enabled', coalesce(s.nightly_enabled, false),
    'night_max_customers', coalesce(s.night_max_customers, 300),
    'night_max_micros', coalesce(s.night_max_micros, 3000000),
    'month_cap_micros', s.month_cap_micros,
    'discovery_nightly_enabled', coalesce(s.discovery_nightly_enabled, false),
    'discovery_night_creators', coalesce(s.discovery_night_creators, 10),
    'discovery_night_max_micros', coalesce(s.discovery_night_max_micros, 1000000))
  from (select 1) one
  left join public.affiliate_studio_spend_settings s on s.company_entity_id = p_company
$$;
revoke all on function public.affiliate_studio_spend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_studio_spend(uuid, uuid) to service_role;

-- 5 ── What the Billing tab shows (before 4, which returns it) ───────────
create or replace function public.affiliate_studio_spend_summary()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_co uuid := public.active_company_id();
  v jsonb;
  n record;
  d record;
begin
  if v_co is null then return null; end if;
  if not exists (select 1 from public.entity_memberships m where m.entity_id = v_co and m.user_id = auth.uid()) then
    return null;
  end if;
  v := public.affiliate_studio_spend(v_co, null);
  select s.started_at, s.finished_at, s.status, s.checked, s.found, s.error_message,
         coalesce((s.filters->>'to_check')::int, 0) as to_check
    into n
    from public.affiliate_customer_scans s
   where s.company_entity_id = v_co and s.filters->>'nightly' = 'true'
   order by s.started_at desc limit 1;
  -- Counts only: never cost_usd, the provider's price.
  select r.started_at, r.finished_at, r.status, r.prospects_new, p.name as program
    into d
    from public.affiliate_discovery_runs r
    left join public.affiliate_programs p on p.id = r.program_id
   where r.company_entity_id = v_co and r.nightly
   order by r.started_at desc limit 1;
  return v || jsonb_build_object(
    'can_edit', coalesce(public.is_owner_admin_of_active_company(), false),
    'last_night', case when n.started_at is null then null else jsonb_build_object(
      'started_at', n.started_at, 'finished_at', n.finished_at, 'status', n.status,
      'checked', n.checked, 'likely', n.found, 'to_check', n.to_check, 'note', n.error_message) end,
    'last_discovery', case when d.started_at is null then null else jsonb_build_object(
      'started_at', d.started_at, 'finished_at', d.finished_at, 'status', d.status,
      'new', coalesce(d.prospects_new, 0), 'program', d.program) end);
end $$;
revoke all on function public.affiliate_studio_spend_summary() from public, anon;
grant execute on function public.affiliate_studio_spend_summary() to authenticated;

-- 4 ── The write path, now with Discovery ────────────────────────────────
-- The 4-argument version is replaced; the page sends named arguments, and a
-- Discovery argument left out (null) keeps what is stored.
drop function if exists public.affiliate_studio_set_spend(boolean, integer, numeric, numeric);
create or replace function public.affiliate_studio_set_spend(
  p_nightly boolean, p_night_customers integer, p_night_usd numeric, p_month_usd numeric default null,
  p_discovery boolean default null, p_discovery_creators integer default null, p_discovery_usd numeric default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_co uuid := public.active_company_id();
  cur public.affiliate_studio_spend_settings;
begin
  if v_co is null then raise exception 'No active company.' using errcode = '42501'; end if;
  if not coalesce(public.is_owner_admin_of_active_company(), false) then
    raise exception 'Only a workspace owner or admin can change Affiliate Studio limits.' using errcode = '42501';
  end if;
  if p_night_customers is null or p_night_customers < 1 or p_night_customers > 5000 then
    raise exception 'Customers per night must be between 1 and 5,000.' using errcode = '22023';
  end if;
  if p_night_usd is null or p_night_usd <= 0 or p_night_usd > 10000 then
    raise exception 'The nightly spend limit must be more than $0 and at most $10,000.' using errcode = '22023';
  end if;
  if p_month_usd is not null and (p_month_usd <= 0 or p_month_usd > 1000000) then
    raise exception 'The monthly cap must be more than $0, or blank for no cap.' using errcode = '22023';
  end if;
  if p_discovery_creators is not null and (p_discovery_creators < 1 or p_discovery_creators > 50) then
    raise exception 'Discovery creators per night must be between 1 and 50.' using errcode = '22023';
  end if;
  if p_discovery_usd is not null and (p_discovery_usd <= 0 or p_discovery_usd > 10000) then
    raise exception 'The nightly Discovery spend limit must be more than $0 and at most $10,000.' using errcode = '22023';
  end if;
  select * into cur from public.affiliate_studio_spend_settings where company_entity_id = v_co;
  insert into public.affiliate_studio_spend_settings as s
    (company_entity_id, nightly_enabled, night_max_customers, night_max_micros, month_cap_micros,
     discovery_nightly_enabled, discovery_night_creators, discovery_night_max_micros, updated_by, updated_at)
  values (v_co, coalesce(p_nightly, false), p_night_customers, round(p_night_usd * 1000000)::bigint,
          case when p_month_usd is null then null else round(p_month_usd * 1000000)::bigint end,
          coalesce(p_discovery, cur.discovery_nightly_enabled, false),
          coalesce(p_discovery_creators, cur.discovery_night_creators, 10),
          coalesce(round(p_discovery_usd * 1000000)::bigint, cur.discovery_night_max_micros, 1000000),
          auth.uid(), now())
  on conflict (company_entity_id) do update set
    nightly_enabled = excluded.nightly_enabled, night_max_customers = excluded.night_max_customers,
    night_max_micros = excluded.night_max_micros, month_cap_micros = excluded.month_cap_micros,
    discovery_nightly_enabled = excluded.discovery_nightly_enabled,
    discovery_night_creators = excluded.discovery_night_creators,
    discovery_night_max_micros = excluded.discovery_night_max_micros,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return public.affiliate_studio_spend_summary();
end $$;
revoke all on function public.affiliate_studio_set_spend(boolean, integer, numeric, numeric, boolean, integer, numeric) from public, anon;
grant execute on function public.affiliate_studio_set_spend(boolean, integer, numeric, numeric, boolean, integer, numeric) to authenticated;

select public.refresh_chat_schema_catalog();
