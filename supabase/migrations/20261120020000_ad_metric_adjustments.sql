-- Ad metric adjustments: a company corrects a known-bad metric on its own ad data.
--
-- Why: an ad platform sometimes reports a metric it later admits was wrong — a
-- conversion-value bug on a handful of campaign-days, a double-counted purchase,
-- a test campaign whose revenue was never real. Until now the only options were
-- to live with the number or to hand-edit rows the next sync would overwrite.
--
-- Shape: one row per correction, scoped by platform (required), optional
-- account/campaign and a date range, naming ONE metric and either excluding it
-- (set to zero) or overriding it with a value. The row carries the reason and
-- who filed it, so the correction is auditable and reversible: deleting it puts
-- the platform's own number back.
--
-- Where it applies: marketing_kpis_daily itself, not only the reporting views.
-- Pages (/v2/marketing-overview.html, /v2/marketing-explorer.html), saved
-- reports, Ask SILO and the MCP all read that table directly, so correcting the
-- stored row is the only way they agree. The platform's raw value is kept in
-- extra.silo_adjusted.<metric>.raw, so nothing is lost.
--
-- Two paths keep it true:
--   * a BEFORE INSERT/UPDATE trigger on marketing_kpis_daily, so every writer
--     (the nightly Node sync, the ad-platform-sync-run edge function, Windsor,
--     any backfill) lands corrected rows without a deploy. It is fail-soft: if
--     the lookup errors the raw row is stored unchanged and a warning is raised,
--     because a wrong number is better than a broken sync.
--   * apply_ad_metric_adjustments(), which corrects rows already stored. It runs
--     automatically when an adjustment is filed or edited.
--
-- Nothing here names a company, platform or campaign: all of that is data.

create table if not exists public.ad_metric_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  platform text not null,
  account_id text,
  campaign_id text,
  campaign_name text,
  day_from date not null,
  day_to date,
  metric text not null,
  mode text not null default 'exclude',
  override_value numeric,
  reason text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_metric_adjustments_metric_check
    check (metric in ('spend', 'conversions', 'conversion_value', 'impressions', 'clicks', 'sessions')),
  constraint ad_metric_adjustments_mode_check check (mode in ('exclude', 'override')),
  constraint ad_metric_adjustments_value_check
    check (mode <> 'override' or override_value is not null),
  constraint ad_metric_adjustments_range_check check (day_to is null or day_to >= day_from)
);

comment on table public.ad_metric_adjustments is
  'One auditable correction to a metric on marketing_kpis_daily: scope (platform, optional account/campaign, date range), the metric, exclude or override, the reason and who filed it. Deleting the row restores the platform''s own value.';

create index if not exists ad_metric_adjustments_scope_idx
  on public.ad_metric_adjustments (company_entity_id, platform) where is_active;

drop trigger if exists ad_metric_adjustments_touch on public.ad_metric_adjustments;
create trigger ad_metric_adjustments_touch
  before update on public.ad_metric_adjustments
  for each row execute function public.set_updated_at();

alter table public.ad_metric_adjustments enable row level security;

drop policy if exists ad_metric_adjustments_select on public.ad_metric_adjustments;
create policy ad_metric_adjustments_select on public.ad_metric_adjustments
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists ad_metric_adjustments_insert on public.ad_metric_adjustments;
create policy ad_metric_adjustments_insert on public.ad_metric_adjustments
  for insert to authenticated
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

drop policy if exists ad_metric_adjustments_update on public.ad_metric_adjustments;
create policy ad_metric_adjustments_update on public.ad_metric_adjustments
  for update to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

drop policy if exists ad_metric_adjustments_delete on public.ad_metric_adjustments;
create policy ad_metric_adjustments_delete on public.ad_metric_adjustments
  for delete to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

grant select, insert, update, delete on public.ad_metric_adjustments to authenticated;
revoke all on public.ad_metric_adjustments from anon;
revoke all on public.ad_metric_adjustments from silo_integration;

-- The value an adjustment asks for, cast the way the target column stores it.
create or replace function public.ad_metric_adjustment_target(p_metric text, p_mode text, p_value numeric)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_target numeric := case when p_mode = 'override' then p_value else 0 end;
  v_type text;
begin
  select a.atttypid::regtype::text into v_type
    from pg_attribute a
   where a.attrelid = 'public.marketing_kpis_daily'::regclass
     and a.attname = p_metric
     and a.attnum > 0
     and not a.attisdropped;
  if v_type is null then
    return null;             -- not a column we can adjust
  end if;
  -- An integer column cannot take 7.6 through jsonb_populate_record (the
  -- trigger's path), so the value is rounded to what the column stores.
  if v_type in ('bigint', 'integer', 'smallint') then
    v_target := round(v_target);
  end if;
  return v_target;
end $$;

revoke all on function public.ad_metric_adjustment_target(text, text, numeric) from public, anon, authenticated, silo_integration;

-- Every writer of marketing_kpis_daily goes through this, so a corrected metric
-- survives the next sync. Fail-soft on purpose: a raw row beats a broken sync.
create or replace function public.tg_marketing_kpis_apply_adjustments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ad_metric_adjustments;
  v_row jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_marks jsonb := '{}'::jsonb;
  v_raw numeric;
  v_target numeric;
begin
  begin
    v_row := to_jsonb(new);
    for a in
      select * from public.ad_metric_adjustments adj
       where adj.is_active
         and adj.company_entity_id = new.company_entity_id
         and adj.platform = new.platform
         and new.day_date >= adj.day_from
         and (adj.day_to is null or new.day_date <= adj.day_to)
         and (adj.account_id is null or adj.account_id = new.account_id)
         and (adj.campaign_id is null or adj.campaign_id = new.campaign_id)
         and (adj.campaign_name is null or adj.campaign_name = new.campaign_name)
       order by adj.created_at
    loop
      v_target := public.ad_metric_adjustment_target(a.metric, a.mode, a.override_value);
      continue when v_target is null;
      v_raw := nullif(v_row ->> a.metric, '')::numeric;
      continue when v_raw is not distinct from v_target;
      v_patch := v_patch || jsonb_build_object(a.metric, v_target);
      v_marks := v_marks || jsonb_build_object(a.metric, jsonb_build_object(
        'raw', v_raw, 'adjustment_id', a.id, 'mode', a.mode, 'at', now()));
    end loop;

    if v_patch = '{}'::jsonb then
      return new;
    end if;
    v_patch := v_patch || jsonb_build_object('extra',
      coalesce(new.extra, '{}'::jsonb) || jsonb_build_object('silo_adjusted',
        coalesce(new.extra -> 'silo_adjusted', '{}'::jsonb) || v_marks));
    new := jsonb_populate_record(new, v_patch);
    return new;
  exception when others then
    raise warning 'ad metric adjustments skipped for marketing_kpis_daily row: %', sqlerrm;
    return new;
  end;
end $$;

-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase re-grants it
-- to anon and authenticated, so all three are revoked explicitly. A trigger does
-- not need EXECUTE on its own function.
revoke all on function public.tg_marketing_kpis_apply_adjustments() from public, anon, authenticated, silo_integration;

-- Named to sort AFTER stamp_company_entity_id: BEFORE row triggers fire in name
-- order, and this one needs the stamped company to find a matching adjustment.
drop trigger if exists marketing_kpis_apply_adjustments on public.marketing_kpis_daily;
drop trigger if exists zz_apply_ad_metric_adjustments on public.marketing_kpis_daily;
create trigger zz_apply_ad_metric_adjustments
  before insert or update on public.marketing_kpis_daily
  for each row execute function public.tg_marketing_kpis_apply_adjustments();

-- Correct rows that are already stored. Returns the number of rows changed.
create or replace function public.apply_ad_metric_adjustments(p_adjustment uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ad_metric_adjustments;
  v_target numeric;
  v_n integer;
  v_total integer := 0;
begin
  for a in
    select * from public.ad_metric_adjustments adj
     where adj.is_active and (p_adjustment is null or adj.id = p_adjustment)
  loop
    v_target := public.ad_metric_adjustment_target(a.metric, a.mode, a.override_value);
    continue when v_target is null;
    execute format($f$
      update public.marketing_kpis_daily k
         set %1$I = %2$L::numeric,
             -- jsonb_set cannot create a missing parent key, so the
             -- silo_adjusted object is merged in explicitly.
             extra = coalesce(k.extra, '{}'::jsonb) || jsonb_build_object('silo_adjusted',
                       coalesce(k.extra -> 'silo_adjusted', '{}'::jsonb)
                       || jsonb_build_object(%3$L, jsonb_build_object(
                            'raw', to_jsonb(k.%1$I), 'adjustment_id', %4$L::text,
                            'mode', %5$L::text, 'at', now())))
       where k.company_entity_id = %6$L
         and k.platform = %7$L
         and k.day_date >= %8$L::date
         and (%9$L::date is null or k.day_date <= %9$L::date)
         and (%10$L::text is null or k.account_id = %10$L)
         and (%11$L::text is null or k.campaign_id = %11$L)
         and (%12$L::text is null or k.campaign_name = %12$L)
         and k.%1$I is distinct from %2$L::numeric
    $f$, a.metric, v_target, a.metric, a.id, a.mode, a.company_entity_id, a.platform,
        a.day_from, a.day_to, a.account_id, a.campaign_id, a.campaign_name);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end $$;

revoke all on function public.apply_ad_metric_adjustments(uuid) from public, anon, authenticated, silo_integration;

-- Put the platform's own value back for one adjustment, from extra.silo_adjusted.
create or replace function public.restore_ad_metric_adjustment(p_adjustment uuid, p_metric text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if public.ad_metric_adjustment_target(p_metric, 'exclude', null) is null then
    return 0;
  end if;
  execute format($f$
    update public.marketing_kpis_daily k
       set %1$I = coalesce((k.extra -> 'silo_adjusted' -> %2$L ->> 'raw')::numeric, k.%1$I),
           extra = case when (coalesce(k.extra -> 'silo_adjusted', '{}'::jsonb) - %2$L) = '{}'::jsonb
                        then k.extra - 'silo_adjusted'
                        else jsonb_set(k.extra, array['silo_adjusted'],
                                       (k.extra -> 'silo_adjusted') - %2$L, true) end
     where k.extra -> 'silo_adjusted' -> %2$L ->> 'adjustment_id' = %3$L
  $f$, p_metric, p_metric, p_adjustment::text);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.restore_ad_metric_adjustment(uuid, text) from public, anon, authenticated, silo_integration;

-- Filing, editing or removing an adjustment corrects history in the same
-- statement, so the admin who filed it sees the new numbers immediately.
create or replace function public.tg_ad_metric_adjustments_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.restore_ad_metric_adjustment(old.id, old.metric);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.is_active then
    perform public.apply_ad_metric_adjustments(new.id);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

revoke all on function public.tg_ad_metric_adjustments_apply() from public, anon, authenticated, silo_integration;

drop trigger if exists ad_metric_adjustments_apply on public.ad_metric_adjustments;
create trigger ad_metric_adjustments_apply
  after insert or update or delete on public.ad_metric_adjustments
  for each row execute function public.tg_ad_metric_adjustments_apply();

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
