-- Business-timezone sweep, part 2 of 5: the SEO workflow's ordering rules judge
-- "the day of the change" in the COMPANY'S business day. Needs
-- silo_company_timezone() from 20260924130000; see that file's header for the
-- whole sweep.

-- ── 1. SEO: publication and measurement windows in the company's calendar ──
-- seo_baseline_conflicts stays IMMUTABLE by taking the timezone as an
-- argument; its only callers are the two triggers below, which resolve it
-- from the row's company. The two-argument form is dropped, not kept beside
-- it: a Pacific-only overload left in place is exactly the site this sweep
-- exists to remove.
create or replace function public.seo_baseline_conflicts(
  p_period_end date,
  p_published timestamptz,
  p_tz text
)
returns boolean
language sql
immutable
as $$
  select p_published is not null
     and p_period_end >= (p_published at time zone p_tz)::date;
$$;

comment on function public.seo_baseline_conflicts(date, timestamptz, text) is
  'True when a baseline window ending p_period_end would reach the day of the change published at p_published, judged in the COMPANY''S business day (p_tz), not the session''s. Shared by both SEO ordering triggers so the reciprocal checks cannot drift apart. The timezone is an argument so the function stays IMMUTABLE.';

-- ── The timezone a publication was recorded in, frozen on the row ─────────
-- A publication is an immutable event, and "which day did the change land"
-- must not move if the company later edits its timezone in Workspace
-- Settings: recomputing it from the CURRENT setting would reclassify which
-- baselines and follow-ups are admissible after the fact (a publication at
-- 05:30Z on Sep 2 is Sep 2 Eastern and Sep 1 Pacific). Same reasoning, and the
-- same mechanism, as forecast_candidate_ledger.business_timezone in 130200.
-- Existing rows (0 in production on 2026-09-24) are backfilled Pacific, which
-- is what they were judged in.
alter table public.seo_task_publications
  add column if not exists business_timezone text not null default 'America/Los_Angeles';
alter table public.seo_task_publications
  alter column business_timezone drop default;

comment on column public.seo_task_publications.business_timezone is
  'The company''s business timezone when the publication was recorded, stamped by trg_business_timezone_seo_publication and never changed afterwards. The ordering triggers and seo_follow_up_window read the publication''s business day through it, so a later timezone change does not reclassify a past publication (20260924130100).';

create or replace function public.seo_publication_stamp_business_timezone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.business_timezone := public.silo_company_timezone(new.company_entity_id);
  else
    new.business_timezone := old.business_timezone;   -- frozen, whoever writes
  end if;
  return new;
end;
$$;

revoke execute on function public.seo_publication_stamp_business_timezone() from public, anon, authenticated;

-- Named to sort AFTER stamp_company_entity_id and BEFORE
-- trg_check_publication_after_baselines (BEFORE triggers fire in name order),
-- so the check reads a stamped value for the right company.
drop trigger if exists trg_business_timezone_seo_publication on public.seo_task_publications;
create trigger trg_business_timezone_seo_publication
  before insert or update on public.seo_task_publications
  for each row execute function public.seo_publication_stamp_business_timezone();

create or replace function public.check_publication_after_baselines()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tz text;
  v_bad date;
  v_follow date;
begin
  -- Stamped by trg_business_timezone_seo_publication, which fires first.
  v_tz := coalesce(new.business_timezone, public.silo_company_timezone(new.company_entity_id));
  select max(m.period_end) into v_bad
  from public.seo_measurements m
  where m.task_id = new.task_id
    and m.window_kind = 'baseline'
    and public.seo_baseline_conflicts(m.period_end, new.published_at, v_tz);

  if v_bad is not null then
    raise exception
      'cannot record publication at % -- this task already has a baseline whose window ends %, which would then straddle the change',
      new.published_at, v_bad
      using errcode = 'check_violation';
  end if;

  select min(m.period_start) into v_follow
  from public.seo_measurements m
  where m.task_id = new.task_id
    and m.window_kind = 'follow_up'
    and m.period_start <= (new.published_at at time zone v_tz)::date;

  if v_follow is not null then
    raise exception
      'cannot record publication at % -- this task already has a follow-up window starting %, which would then begin on or before the latest change; an approver must delete that follow-up first',
      new.published_at, v_follow
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create or replace function public.check_seo_measurement_window()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_first timestamptz;
  v_first_tz text;
  v_last timestamptz;
  v_last_tz text;
begin
  if new.task_id is null then
    return new;
  end if;

  -- Each publication is judged in the timezone it was RECORDED in, not the
  -- company's current setting.
  select p.published_at, p.business_timezone into v_first, v_first_tz
  from public.seo_task_publications p
  where p.task_id = new.task_id
  order by p.published_at asc
  limit 1;

  select p.published_at, p.business_timezone into v_last, v_last_tz
  from public.seo_task_publications p
  where p.task_id = new.task_id
  order by p.published_at desc
  limit 1;

  if new.window_kind = 'baseline' then
    if public.seo_baseline_conflicts(new.period_end, v_first, v_first_tz) then
      raise exception
        'baseline period ends % but the task was published % -- a window ending on or after the change is a follow-up, not a baseline',
        new.period_end, v_first
        using errcode = 'check_violation';
    end if;
  elsif new.window_kind = 'follow_up' then
    if v_last is null then
      raise exception
        'a follow-up needs a recorded publication to follow -- record the publication in seo_task_publications first'
        using errcode = 'check_violation';
    end if;
    if new.period_start <= (v_last at time zone v_last_tz)::date then
      raise exception
        'follow-up period starts % but the task was last published % -- a follow-up window starts after the change, never on or before it',
        new.period_start, v_last
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.seo_follow_up_window(
  p_task_id uuid,
  p_days_after integer
) returns table (
  published_on date,
  baseline_start date,
  baseline_end date,
  baseline_days integer,
  period_start date,
  period_end date,
  measurable boolean,
  reason text
)
language sql
stable
security invoker
set search_path = public
as $$
with pub as (
  -- The latest publication's day in the timezone it was recorded in. A scalar
  -- subquery, so a task with no publication still yields one NULL row (the
  -- "no publication recorded" reason below depends on it).
  select (select (p.published_at at time zone p.business_timezone)::date
            from public.seo_task_publications p
           where p.task_id = p_task_id
           order by p.published_at desc
           limit 1) as published_on
),
base as (
  select m.period_start, m.period_end, (m.period_end - m.period_start + 1) as days
  from public.seo_measurements m
  where m.task_id = p_task_id and m.window_kind = 'baseline'
  order by m.period_end desc, m.period_start desc
  limit 1
),
sc as (
  select max(d.day_date) as max_day
  from public.search_console_site_daily d
  where d.company_entity_id = public.active_company_id()
),
calc as (
  select pub.published_on, base.period_start as baseline_start, base.period_end as baseline_end,
         base.days as baseline_days,
         case when pub.published_on is null or base.days is null then null
              else pub.published_on + greatest(coalesce(p_days_after, 0), 1) - base.days + 1 end as period_start,
         case when pub.published_on is null then null
              else pub.published_on + greatest(coalesce(p_days_after, 0), 1) end as period_end,
         sc.max_day
  from pub cross join base cross join sc
  union all
  -- No baseline row: still return the publication so the caller can say why.
  select pub.published_on, null, null, null, null,
         case when pub.published_on is null then null
              else pub.published_on + greatest(coalesce(p_days_after, 0), 1) end,
         sc.max_day
  from pub cross join sc
  where not exists (select 1 from base)
)
select c.published_on, c.baseline_start, c.baseline_end, c.baseline_days, c.period_start, c.period_end,
  case
    when c.published_on is null then false
    when c.baseline_days is null then false
    when c.period_start <= c.published_on then false
    when c.period_end >= public.silo_business_today() then false
    when c.max_day is null or c.max_day < c.period_end then false
    else true
  end as measurable,
  case
    when c.published_on is null then 'no publication recorded for this task'
    when c.baseline_days is null then 'no baseline captured for this task; capture one over a window that ends before the publication'
    when c.period_start <= c.published_on then format('a %s-day window ending %s days after publication would start on or before the change; p_days_after must be at least %s', c.baseline_days, p_days_after, c.baseline_days)
    when c.period_end >= public.silo_business_today() then format('window ends %s, which is not a completed business day yet', c.period_end)
    when c.max_day is null then 'no Search Console data ingested for this company'
    when c.max_day < c.period_end then format('Search Console data ends %s; the window ends %s', c.max_day, c.period_end)
    else null
  end as reason
from calc c;
$$;

-- The triggers above now call the three-argument form; the old one has no
-- caller left.
drop function if exists public.seo_baseline_conflicts(date, timestamptz);

