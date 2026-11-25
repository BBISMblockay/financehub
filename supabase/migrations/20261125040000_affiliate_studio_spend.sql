-- Affiliate Studio spend: one bill line, the company's own limits, and the
-- nightly Find (Blake 2026-11-25).
--
--   "track their discovery tool usage, bill for it at markup, but leave
--    configurable so its on them to set cap or enable fundings or keep
--    discovery not on auto"
--   "discovery as one usage, not customer vs outward discovery ... one
--    'studio' bill"
--
-- What already exists and is reused, unchanged:
--   * ai_credit_reservations / ai_credit_settle (20261001120000): every Find
--     and Discovery AI call is already metered under feature
--     'affiliate_research', at the company's multiplier, in customer dollars.
--   * affiliate-research now ALSO meters its Google searches through the same
--     RPCs, under the same feature, as model 'dataforseo-serp' with usage
--     {web_search: n}. The price of one search is an ai_provider_rates row
--     (web_search_micros_per_request) added at rollout -- never in the repo.
--     Until that row exists, searches are recorded unpriced: nothing is
--     charged for them, and the dollar limits below see only the AI part.
--
-- So 'affiliate_research' IS the one Affiliate Studio line: Find (customers)
-- and Discovery (outward) are never split.
--
-- This migration adds:
--   1. affiliate_studio_spend_settings -- one row per company: nightly Find
--      on/off (off by default), the per-night customer and dollar limits, and
--      an optional monthly dollar cap over ALL Studio usage.
--   2. affiliate_studio_set_spend(...) -- the only write path; owner/admin of
--      the active company (the same gate as buying credit).
--   3. affiliate_studio_spend_summary() -- what the Billing tab shows: this
--      month's Studio usage in CUSTOMER dollars, the limits, the last nightly
--      run. Never provider cost, rates or the multiplier.
--   4. affiliate_studio_spend(p_company, p_scan) -- service role only: the
--      same month figure, plus one scan's own spend, for the edge function's
--      cap checks. One definition of "this month" for page and function.
--
-- Idempotent. No data is changed.

-- 1 ── Settings ──────────────────────────────────────────────────────────
create table if not exists public.affiliate_studio_spend_settings (
  company_entity_id   uuid primary key references public.entities(id) on delete cascade,
  nightly_enabled     boolean not null default false,
  night_max_customers integer not null default 300 check (night_max_customers between 1 and 5000),
  -- Customer dollars, in micro-USD ($1 = 1,000,000), like the credit ledger.
  night_max_micros    bigint  not null default 3000000 check (night_max_micros > 0),
  month_cap_micros    bigint  check (month_cap_micros is null or month_cap_micros > 0),
  updated_by          uuid,
  updated_at          timestamptz not null default now()
);
comment on table public.affiliate_studio_spend_settings is
  'Affiliate Studio spend limits per company: nightly Find on/off and its per-night customer and dollar limits, and an optional monthly cap over all Studio usage (Find + Discovery). Customer micro-USD. Written only by affiliate_studio_set_spend(). 20261125040000.';

alter table public.affiliate_studio_spend_settings enable row level security;
drop policy if exists affiliate_studio_spend_settings_read on public.affiliate_studio_spend_settings;
create policy affiliate_studio_spend_settings_read on public.affiliate_studio_spend_settings
  for select to authenticated using (company_entity_id = public.active_company_id());
revoke all on public.affiliate_studio_spend_settings from anon, authenticated;
grant select on public.affiliate_studio_spend_settings to authenticated;

-- 4 ── The figure both the page and the function use ─────────────────────
-- Settled, succeeded Studio operations since the start of the company's
-- current calendar month (its own timezone), in customer dollars: what was
-- charged where billing is enforced, what would be charged where it is in
-- shadow. Unpriced operations count 0 (nothing to bill).
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
  )
  select jsonb_build_object(
    'month_start', (select month_start from b),
    'month_micros', coalesce((select sum(micros) from r), 0),
    'scan_micros', case when p_scan is null then null
                        else coalesce((select sum(micros) from r where source_ref = p_scan::text), 0) end,
    'nightly_enabled', coalesce(s.nightly_enabled, false),
    'night_max_customers', coalesce(s.night_max_customers, 300),
    'night_max_micros', coalesce(s.night_max_micros, 3000000),
    'month_cap_micros', s.month_cap_micros)
  from (select 1) one
  left join public.affiliate_studio_spend_settings s on s.company_entity_id = p_company
$$;
revoke all on function public.affiliate_studio_spend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_studio_spend(uuid, uuid) to service_role;

-- 2 ── The write path ────────────────────────────────────────────────────
-- Dollars in, micros stored. A blank monthly cap (null) means no cap.
create or replace function public.affiliate_studio_set_spend(
  p_nightly boolean, p_night_customers integer, p_night_usd numeric, p_month_usd numeric default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_co uuid := public.active_company_id();
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
  insert into public.affiliate_studio_spend_settings as s
    (company_entity_id, nightly_enabled, night_max_customers, night_max_micros, month_cap_micros, updated_by, updated_at)
  values (v_co, coalesce(p_nightly, false), p_night_customers, round(p_night_usd * 1000000)::bigint,
          case when p_month_usd is null then null else round(p_month_usd * 1000000)::bigint end, auth.uid(), now())
  on conflict (company_entity_id) do update set
    nightly_enabled = excluded.nightly_enabled, night_max_customers = excluded.night_max_customers,
    night_max_micros = excluded.night_max_micros, month_cap_micros = excluded.month_cap_micros,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return public.affiliate_studio_spend_summary();
end $$;
revoke all on function public.affiliate_studio_set_spend(boolean, integer, numeric, numeric) from public, anon;
grant execute on function public.affiliate_studio_set_spend(boolean, integer, numeric, numeric) to authenticated;

-- 3 ── What the Billing tab shows ────────────────────────────────────────
-- Customer dollars only. The last nightly run is the newest scan the nightly
-- job started (filters.nightly), with its counts -- never its cost_usd, which
-- is the provider's price.
create or replace function public.affiliate_studio_spend_summary()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_co uuid := public.active_company_id();
  v jsonb;
  n record;
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
  return v || jsonb_build_object(
    'can_edit', coalesce(public.is_owner_admin_of_active_company(), false),
    'last_night', case when n.started_at is null then null else jsonb_build_object(
      'started_at', n.started_at, 'finished_at', n.finished_at, 'status', n.status,
      'checked', n.checked, 'likely', n.found, 'to_check', n.to_check, 'note', n.error_message) end);
end $$;
revoke all on function public.affiliate_studio_spend_summary() from public, anon;
grant execute on function public.affiliate_studio_spend_summary() to authenticated;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
