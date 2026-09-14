-- SEO workflow: the measurement slice, and two invariants the schema was
-- missing.
--
-- docs/ops/seo-project.md has said since 2026-09-08 that "baseline is captured
-- by a DETERMINISTIC FUNCTION, before publication -- never by the model
-- writing numbers into a row". Inspected 2026-09-14: no such function existed.
-- seo_measurements accepted any value from any company member, so a baseline
-- was exactly as reproducible as whoever typed it. This migration adds that
-- function, plus the follow-up window it will be compared against, and closes
-- two gaps found in the same inspection:
--
--   1. A publication could be recorded for a task nobody had approved. The
--      schema's first invariant (approval never publishes) was structural, but
--      its converse -- publication requires approval -- was not enforced at
--      all, so the sequence recommendation -> approval -> publication held only
--      by convention.
--   2. A follow-up window had no ordering rule. A baseline may not reach the
--      publication (two triggers, 20260909260000); a follow-up dated BEFORE the
--      change, or straddling it, was accepted without comment.
--
-- WHAT A CAPTURE IS. seo_capture_measurements(task, window_kind, start, end)
-- reads, under the CALLER's RLS, the two sources SILO actually holds for a
-- page and writes one seo_measurements row per metric, each carrying its
-- source, dimensions, filters, completeness and (where one exists) the latest
-- page_inspections row as evidence:
--
--   search_console_page   clicks, impressions, pooled ctr, impression-weighted
--                         position, days the page was returned -- from
--                         search_console_page_daily, for the company's ONE
--                         ingested property, only when the task's host is the
--                         property's host. A page returned on no day is
--                         written as a NULL value with a note, never 0: Google
--                         does not guarantee every page row is returned.
--   shopify_landing_pages sessions, completed checkouts, days present -- from
--                         the top-N truncated landing-page table for the shop
--                         that serves the task's host. is_complete is FALSE by
--                         construction (every day of that table is capped) and
--                         an absent page is again NULL with a note.
--
-- The two sources are two sets of rows and are never combined: sessions are
-- on-site sessions, not organic sessions, and no join attributes either to a
-- search query. Search Console query rows are deliberately NOT captured per
-- task -- the query x page pair is not ingested (see 20260910180000) and a
-- per-task query figure would invite exactly that inference.
--
-- A capture is FROZEN: a second call for the same task, window kind and period
-- returns already_captured and writes nothing. Search Console restates its
-- data, so the number a later comparison is measured against must be the one
-- that was recorded, not a re-read. Correcting one is an approver's delete
-- plus a fresh capture, which is itself attributable.
--
-- No delta is computed here or anywhere: a before/after movement is evidence of
-- movement, never proof of causation. seo_follow_up_window() only says WHICH
-- window is the equivalent one, so the comparison is made in the open.

-- ── 1. Publication requires an approved task, and cannot be in the future ────
create or replace function public.check_seo_publication_admissible()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_status text;
begin
  select t.approval_status into v_status
  from public.seo_tasks t
  where t.id = new.task_id and t.company_entity_id = new.company_entity_id;

  if v_status is null then
    raise exception 'publication cites a task that does not exist in this company'
      using errcode = 'foreign_key_violation';
  end if;
  if v_status <> 'approved' then
    raise exception 'cannot record a publication for a task whose approval_status is % -- approval and publication are different facts, and this one requires the other first', v_status
      using errcode = 'check_violation';
  end if;
  if new.published_at > now() then
    raise exception 'published_at % is in the future -- a publication is recorded after the change went live, never scheduled', new.published_at
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_seo_publication_admissible on public.seo_task_publications;
create trigger trg_seo_publication_admissible
  before insert or update on public.seo_task_publications
  for each row execute function public.check_seo_publication_admissible();

comment on function public.check_seo_publication_admissible() is
  'A publication row may cite only an APPROVED task and may not be dated in '
  'the future. The converse of invariant 1 (approval never publishes): '
  'publication requires approval. Added 20260914120000.';

-- ── 2. Both window kinds are ordered against the publication ────────────────
-- Replaces check_seo_baseline_precedes_publication(): the baseline half is
-- unchanged (still shares seo_baseline_conflicts() with the reciprocal trigger
-- on publications); the follow-up half is new. A follow-up must START after
-- the LATEST publication of the task -- a task published twice (a correction)
-- has no clean window between the two.
create or replace function public.check_seo_measurement_window()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_first timestamptz;
  v_last timestamptz;
begin
  if new.task_id is null then
    return new;
  end if;

  select min(p.published_at), max(p.published_at) into v_first, v_last
  from public.seo_task_publications p
  where p.task_id = new.task_id;

  if new.window_kind = 'baseline' then
    if public.seo_baseline_conflicts(new.period_end, v_first) then
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
    if new.period_start <= (v_last at time zone 'America/Los_Angeles')::date then
      raise exception
        'follow-up period starts % but the task was last published % -- a follow-up window starts after the change, never on or before it',
        new.period_start, v_last
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_seo_baseline_precedes_publication on public.seo_measurements;
drop trigger if exists trg_seo_measurement_window on public.seo_measurements;
create trigger trg_seo_measurement_window
  before insert or update on public.seo_measurements
  for each row execute function public.check_seo_measurement_window();
drop function if exists public.check_seo_baseline_precedes_publication();

comment on function public.check_seo_measurement_window() is
  'Orders every task-level measurement window against the task''s '
  'publications: a baseline ends before the FIRST publication (Pacific date, '
  '>= refused, via seo_baseline_conflicts); a follow-up starts after the LAST. '
  'Project-level rows (task_id null) are not ordered. 20260914120000.';

-- ── 3. The equivalent follow-up window ───────────────────────────────────────
-- Same length as the task's latest baseline, ending p_days_after days after
-- the (latest) publication date. measurable says whether it can be captured
-- yet and, if not, why -- so "30 days" is a window a person can read, not a
-- number the model rounds.
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
  select (max(p.published_at) at time zone 'America/Los_Angeles')::date as published_on
  from public.seo_task_publications p
  where p.task_id = p_task_id
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
    when c.period_end >= public.silo_business_today() then format('window ends %s, which is not a completed Pacific day yet', c.period_end)
    when c.max_day is null then 'no Search Console data ingested for this company'
    when c.max_day < c.period_end then format('Search Console data ends %s; the window ends %s', c.max_day, c.period_end)
    else null
  end as reason
from calc c;
$$;

revoke all on function public.seo_follow_up_window(uuid, integer) from public, anon;
grant execute on function public.seo_follow_up_window(uuid, integer) to authenticated;

comment on function public.seo_follow_up_window(uuid, integer) is
  'The follow-up window equivalent to a task''s latest baseline: same length, '
  'ending p_days_after days after the latest publication (Pacific). measurable '
  'is false with a reason until the window is a completed day and Search '
  'Console has ingested through its end. SECURITY INVOKER.';

-- ── 4. The deterministic capture ─────────────────────────────────────────────
create or replace function public.seo_capture_measurements(
  p_task_id uuid,
  p_window_kind text,
  p_period_start date,
  p_period_end date
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.seo_tasks%rowtype;
  v_company uuid := public.active_company_id();
  v_today date := public.silo_business_today();
  v_days integer;
  v_host text;
  v_path text;
  v_evidence uuid;
  v_written integer := 0;
  v_sources jsonb := '{}'::jsonb;
  -- Search Console
  v_property_count integer;
  v_site_url text;
  v_property_host text;
  v_sc_days integer; v_sc_truncated integer; v_sc_unmeasured integer; v_sc_max date;
  v_sc_page_days integer; v_sc_clicks bigint; v_sc_impressions bigint; v_sc_pos_w numeric;
  v_sc_complete boolean; v_sc_note text; v_sc_dims jsonb; v_sc_filters jsonb;
  -- Shopify landing pages
  v_shop text;
  v_lp_source_days integer; v_lp_truncated integer; v_lp_days integer;
  v_lp_sessions bigint; v_lp_checkout bigint; v_lp_note text; v_lp_dims jsonb; v_lp_filters jsonb;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'Sign in with an active company before capturing measurements';
  end if;
  if p_window_kind is null or p_window_kind not in ('baseline', 'follow_up') then
    raise exception 'window_kind must be baseline or follow_up';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'period_start and period_end are required and must be ordered';
  end if;
  if p_period_end >= v_today then
    raise exception 'period_end % is not a completed Pacific day (business today is %)', p_period_end, v_today;
  end if;
  v_days := p_period_end - p_period_start + 1;
  if v_days > 366 then
    raise exception 'a measurement window is at most 366 days';
  end if;

  -- RLS decides visibility; a task in another company reads as not found.
  select * into v_task from public.seo_tasks where id = p_task_id;
  if not found then
    raise exception 'SEO task not found';
  end if;

  -- The page. target_url wins; a collection handle is the fallback.
  if v_task.target_url is not null then
    if v_task.target_url !~* '^https?://[^/]+' then
      raise exception 'target_url must be an absolute http(s) URL; got %', v_task.target_url;
    end if;
    v_host := lower(substring(v_task.target_url from '^https?://([^/:?#]+)'));
    v_path := coalesce(nullif(regexp_replace(v_task.target_url, '^https?://[^/]+', ''), ''), '/');
  elsif v_task.target_type = 'collection' and nullif(v_task.target_handle, '') is not null then
    v_host := null;
    v_path := '/collections/' || v_task.target_handle;
  else
    raise exception 'task has no target page: set target_url (or a collection target_handle) before capturing';
  end if;

  -- Frozen: never re-read a window that has already been captured.
  if exists (
    select 1 from public.seo_measurements m
    where m.task_id = p_task_id and m.window_kind = p_window_kind
      and m.period_start = p_period_start and m.period_end = p_period_end
      and m.source in ('search_console_page', 'shopify_landing_pages')
  ) then
    return jsonb_build_object(
      'task_id', p_task_id, 'window_kind', p_window_kind,
      'period_start', p_period_start, 'period_end', p_period_end,
      'already_captured', true, 'rows_written', 0,
      'note', 'this window was captured before and is frozen; an approver may delete the rows and capture again');
  end if;

  -- Evidence: the latest successful capture of this exact URL, if any.
  if v_task.target_url is not null then
    select i.id into v_evidence
    from public.page_inspections i
    where i.company_entity_id = v_company
      and (i.requested_url = v_task.target_url or i.final_url = v_task.target_url)
      and i.fetch_error is null
    order by i.fetched_at desc
    limit 1;
  end if;

  -- ── Search Console (page grain) ──
  select count(distinct site_url), min(site_url)
    into v_property_count, v_site_url
  from public.search_console_site_daily
  where company_entity_id = v_company;

  if v_property_count = 0 then
    v_sources := v_sources || jsonb_build_object('search_console_page',
      jsonb_build_object('skipped', 'no Search Console data ingested for this company'));
  elsif v_property_count > 1 then
    v_sources := v_sources || jsonb_build_object('search_console_page',
      jsonb_build_object('skipped', 'more than one Search Console property is ingested; a page cannot be attributed to one without a property selector'));
  else
    v_property_host := lower(substring(v_site_url from '^https?://([^/:?#]+)'));
    if v_host is not null and v_property_host is not null and v_host <> v_property_host then
      v_sources := v_sources || jsonb_build_object('search_console_page',
        jsonb_build_object('skipped', format('target host %s is not covered by the ingested property %s', v_host, v_site_url)));
    else
      select count(*), count(*) filter (where is_truncated), count(*) filter (where page_attributed_clicks is null), max(day_date)
        into v_sc_days, v_sc_truncated, v_sc_unmeasured, v_sc_max
      from public.search_console_site_daily
      where company_entity_id = v_company and site_url = v_site_url
        and day_date between p_period_start and p_period_end;

      select count(*), coalesce(sum(clicks), 0), coalesce(sum(impressions), 0), coalesce(sum(position * impressions), 0)
        into v_sc_page_days, v_sc_clicks, v_sc_impressions, v_sc_pos_w
      from public.search_console_page_daily
      where company_entity_id = v_company and site_url = v_site_url
        and page_path = v_path
        and day_date between p_period_start and p_period_end;

      v_sc_complete := (v_sc_days = v_days and v_sc_truncated = 0 and v_sc_unmeasured = 0);
      v_sc_note := format(
        'Site rows ingested for %s of %s day(s) in the window (%s truncated, %s unmeasured); the page was returned on %s day(s). '
        || 'Google does not guarantee every page row is returned, so days the page is absent are NOT RETURNED, never zero. '
        || 'Page-level impressions, CTR and position are page semantics and are not comparable to site-level figures. dataState=final.',
        v_sc_days, v_days, v_sc_truncated, v_sc_unmeasured, v_sc_page_days);
      v_sc_dims := jsonb_build_object('site_url', v_site_url, 'page_path', v_path, 'grain', 'page_daily');
      v_sc_filters := jsonb_build_object('data_state', 'final', 'page_path_match', 'exact');

      insert into public.seo_measurements
        (company_entity_id, project_id, task_id, source, metric, value, unit, window_kind,
         period_start, period_end, dimensions, filters, is_complete, completeness_note, evidence_inspection_id)
      values
        (v_company, v_task.project_id, p_task_id, 'search_console_page', 'clicks',
         case when v_sc_page_days = 0 then null else v_sc_clicks end, 'clicks', p_window_kind,
         p_period_start, p_period_end, v_sc_dims, v_sc_filters, v_sc_complete,
         case when v_sc_page_days = 0 then 'page not returned on any day in the window; NULL, not zero. ' || v_sc_note else v_sc_note end, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'search_console_page', 'impressions',
         case when v_sc_page_days = 0 then null else v_sc_impressions end, 'impressions', p_window_kind,
         p_period_start, p_period_end, v_sc_dims, v_sc_filters, v_sc_complete,
         case when v_sc_page_days = 0 then 'page not returned on any day in the window; NULL, not zero. ' || v_sc_note else v_sc_note end, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'search_console_page', 'ctr',
         case when v_sc_impressions > 0 then round(v_sc_clicks::numeric / v_sc_impressions, 6) end, 'ratio', p_window_kind,
         p_period_start, p_period_end, v_sc_dims, v_sc_filters, v_sc_complete,
         'Pooled: sum(clicks)/sum(impressions) over the returned page rows, never an average of daily rates. ' || v_sc_note, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'search_console_page', 'position',
         case when v_sc_impressions > 0 then round(v_sc_pos_w / v_sc_impressions, 2) end, 'average_position', p_window_kind,
         p_period_start, p_period_end, v_sc_dims, v_sc_filters, v_sc_complete,
         'Impression-weighted average of daily average positions; never summed. Lower is better. ' || v_sc_note, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'search_console_page', 'page_days_returned',
         v_sc_page_days, 'days', p_window_kind,
         p_period_start, p_period_end, v_sc_dims, v_sc_filters, v_sc_complete,
         'Days in the window on which Search Console returned a row for this page. ' || v_sc_note, v_evidence);
      v_written := v_written + 5;

      v_sources := v_sources || jsonb_build_object('search_console_page', jsonb_build_object(
        'site_url', v_site_url, 'page_path', v_path,
        'site_days_ingested', v_sc_days, 'window_days', v_days,
        'truncated_days', v_sc_truncated, 'unmeasured_days', v_sc_unmeasured,
        'page_days_returned', v_sc_page_days,
        'clicks', case when v_sc_page_days = 0 then null else v_sc_clicks end,
        'impressions', case when v_sc_page_days = 0 then null else v_sc_impressions end,
        'is_complete', v_sc_complete));
    end if;
  end if;

  -- ── Shopify landing pages (on-site sessions, top-N truncated) ──
  if v_host is null then
    v_sources := v_sources || jsonb_build_object('shopify_landing_pages',
      jsonb_build_object('skipped', 'the task names a handle but no host, so the shop cannot be resolved; set target_url'));
  else
    select d.shop_domain into v_shop
    from public.shopify_shop_domains d
    where d.company_entity_id = v_company and d.host = v_host
    order by case d.kind when 'primary' then 0 else 1 end
    limit 1;

    if v_shop is null then
      v_sources := v_sources || jsonb_build_object('shopify_landing_pages',
        jsonb_build_object('skipped', format('host %s is not a registered storefront for this company', v_host)));
    else
      select count(distinct day_date), count(distinct day_date) filter (where is_truncated)
        into v_lp_source_days, v_lp_truncated
      from public.shopify_landing_pages_daily
      where company_entity_id = v_company and shop_domain = v_shop
        and day_date between p_period_start and p_period_end;

      select count(*), coalesce(sum(sessions), 0), coalesce(sum(sessions_that_completed_checkout), 0)
        into v_lp_days, v_lp_sessions, v_lp_checkout
      from public.shopify_landing_pages_daily
      where company_entity_id = v_company and shop_domain = v_shop
        and landing_page_path = v_path
        and day_date between p_period_start and p_period_end;

      v_lp_note := format(
        'On-site landing SESSIONS from the top-N-per-day landing-page table (NOT organic sessions, NOT search traffic). '
        || 'The shop has rows on %s of %s day(s) in the window, %s of them capped; this page appeared on %s day(s). '
        || 'Days the page is absent are days it fell out of the top N, never zero traffic. Never combine with Search Console rows.',
        v_lp_source_days, v_days, v_lp_truncated, v_lp_days);
      v_lp_dims := jsonb_build_object('shop_domain', v_shop, 'host', v_host, 'landing_page_path', v_path, 'grain', 'landing_page_daily');
      v_lp_filters := jsonb_build_object('top_n_truncated', true, 'landing_page_path_match', 'exact');

      insert into public.seo_measurements
        (company_entity_id, project_id, task_id, source, metric, value, unit, window_kind,
         period_start, period_end, dimensions, filters, is_complete, completeness_note, evidence_inspection_id)
      values
        (v_company, v_task.project_id, p_task_id, 'shopify_landing_pages', 'sessions',
         case when v_lp_days = 0 then null else v_lp_sessions end, 'sessions', p_window_kind,
         p_period_start, p_period_end, v_lp_dims, v_lp_filters, false,
         case when v_lp_days = 0 then 'page absent from the top-N on every day in the window; NULL, not zero. ' || v_lp_note else v_lp_note end, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'shopify_landing_pages', 'sessions_that_completed_checkout',
         case when v_lp_days = 0 then null else v_lp_checkout end, 'sessions', p_window_kind,
         p_period_start, p_period_end, v_lp_dims, v_lp_filters, false,
         case when v_lp_days = 0 then 'page absent from the top-N on every day in the window; NULL, not zero. ' || v_lp_note else v_lp_note end, v_evidence),
        (v_company, v_task.project_id, p_task_id, 'shopify_landing_pages', 'page_days_present',
         v_lp_days, 'days', p_window_kind,
         p_period_start, p_period_end, v_lp_dims, v_lp_filters, false,
         'Days in the window on which this page ranked inside the top N. ' || v_lp_note, v_evidence);
      v_written := v_written + 3;

      v_sources := v_sources || jsonb_build_object('shopify_landing_pages', jsonb_build_object(
        'shop_domain', v_shop, 'landing_page_path', v_path,
        'source_days_available', v_lp_source_days, 'window_days', v_days,
        'truncated_days', v_lp_truncated, 'page_days_present', v_lp_days,
        'sessions', case when v_lp_days = 0 then null else v_lp_sessions end,
        'is_complete', false));
    end if;
  end if;

  if v_written = 0 then
    raise exception 'nothing could be captured for this task: %', v_sources::text;
  end if;

  return jsonb_build_object(
    'task_id', p_task_id, 'window_kind', p_window_kind,
    'period_start', p_period_start, 'period_end', p_period_end,
    'target_host', v_host, 'target_path', v_path,
    'evidence_inspection_id', v_evidence,
    'rows_written', v_written, 'sources', v_sources,
    'caveat', 'A later window that differs from this one is evidence of movement, not proof the change caused it.');
end;
$$;

revoke all on function public.seo_capture_measurements(uuid, text, date, date) from public, anon;
grant execute on function public.seo_capture_measurements(uuid, text, date, date) to authenticated;

comment on function public.seo_capture_measurements(uuid, text, date, date) is
  'Deterministic capture of a task''s page metrics into seo_measurements: '
  'Search Console page rows (exact page_path, one property, host-matched) and '
  'Shopify top-N landing sessions (shop resolved from the host), one row per '
  'metric with source, dimensions, filters, completeness and the latest page '
  'inspection as evidence. Absent = NULL, never 0. Frozen: a repeated window '
  'returns already_captured. SECURITY INVOKER, so RLS scopes every read and '
  'the trigger orders the window against the task''s publications.';

-- ── 5. Ask SILO catalog ──────────────────────────────────────────────────────
-- Appends on the TABLE rows only. refresh_chat_schema_catalog() (20260821210000)
-- prunes every catalog row whose relname is not a public relation, so a row
-- inserted for a FUNCTION is deleted by the refresh at the end of the same
-- migration -- which is what happened to the seo_collection_candidates entry
-- that 20260909380000 seeded. The model finds these functions through the
-- table rows it reads first.
update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' CAPTURE, DO NOT TYPE (20260914120000): task-level rows are written by '
  'seo_capture_measurements(); a follow-up must start after the task''s latest '
  'publication and a baseline must end before its first (trigger-enforced). Use '
  'seo_follow_up_window(task_id, 30|90) to find the equivalent window.',
    updated_at = now()
where relname = 'seo_measurements'
  and coalesce(description, '') not like '%CAPTURE, DO NOT TYPE%';

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' REQUIRES APPROVAL (20260914120000): a row may cite only a task whose '
  'approval_status is approved, and published_at may not be in the future.',
    updated_at = now()
where relname = 'seo_task_publications'
  and coalesce(description, '') not like '%REQUIRES APPROVAL%';

select public.refresh_chat_schema_catalog();
