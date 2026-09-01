-- Week over Week, at four grains: day / week / month-to-date / year-to-date.
--
-- The report was built as a weekly artefact and the 7-day window was typed
-- into every RPC by hand -- eight copies of
--     p_report_date - 6 ... p_report_date - 13 ... p_report_date - 364
-- one per function. Sammie asked to read the same report as a day, a month
-- and a year to date, and the honest way to do that is ONE window definition
-- every RPC delegates to, not four more copies of the arithmetic in eight
-- places. A grain that disagrees with itself between the KPI band and the
-- funnel is worse than no grain at all.
--
-- WHAT "PREVIOUS" MEANS AT EACH GRAIN. This is the part that is easy to get
-- quietly wrong, so it is stated rather than inferred:
--
--   day    current = the day itself
--          prev    = the day before
--          LY      = 364 days back (the same WEEKDAY, not the same date)
--   week   current = the 7 days ending on the report date   [unchanged]
--          prev    = the 7 days before those
--          LY      = 364 days back, so the window lands on the same weekdays
--   month  current = the 1st of the month THROUGH the report date
--          prev    = the same span in the prior calendar month
--          LY      = the same calendar dates last year
--   ytd    current = Jan 1 THROUGH the report date
--          prev    = the equal-length window ending Dec 31
--          LY      = the same calendar dates last year
--
-- MONTH AND YTD ARE TO-DATE, NOT WHOLE PERIODS. A report dated the 12th
-- compared against a complete prior month reads as a 60% collapse every
-- single time, and the reader has no way to see that the windows were never
-- the same length. To-date against to-date is the only comparison that says
-- something about the business rather than about the calendar.
--
-- YTD's "previous" is deliberately NOT last year's YTD. That is what the LY
-- column already holds, and two columns showing the same window read as
-- corroboration when they are duplication. The equal-length window ending
-- Dec 31 is a real, different answer -- except on Dec 31 itself, where the
-- equal-length window ending Dec 31 IS the prior year and the two columns
-- legitimately coincide. That is arithmetic, not a bug; the period bar prints
-- both windows' dates, so the reader can see it rather than be told.
--
-- 364 rather than 365 for day/week is the existing rule and it is kept: a
-- 7-day window that shifts a Saturday in or out moves the number more than
-- real demand does. Month and YTD are calendar-driven rather than
-- weekday-driven, so those align on the date instead.

create or replace function public.wow_window(p_report_date date, p_grain text default 'week')
returns table (s date, e date, ps date, pe date, lys date, lye date)
language plpgsql
immutable
as $fn$
declare
  k    text := lower(coalesce(nullif(btrim(p_grain), ''), 'week'));
  span int;
begin
  -- Raise rather than silently falling back to 'week'. A typo in a grain would
  -- otherwise return a perfectly plausible week of numbers under a heading
  -- that says "month", which is the worst failure this function has available.
  if k not in ('day', 'week', 'month', 'ytd') then
    raise exception 'wow_window: unknown grain %; expected day, week, month or ytd', p_grain;
  end if;

  e := p_report_date;

  if k = 'day' then
    s   := p_report_date;
    ps  := s - 1;    pe  := e - 1;
    lys := s - 364;  lye := e - 364;

  elsif k = 'week' then
    s   := p_report_date - 6;
    ps  := s - 7;    pe  := e - 7;
    lys := s - 364;  lye := e - 364;

  elsif k = 'month' then
    s    := date_trunc('month', p_report_date)::date;
    span := e - s;
    ps   := (s - interval '1 month')::date;
    -- Clamp to the prior month's own last day. Mar 31 back one month is
    -- February, which has no 31st: without the clamp the "prior month" window
    -- runs past its month end and double-counts days that belong to the
    -- current one, inflating the base and printing a decline that never
    -- happened.
    pe   := least(ps + span, (date_trunc('month', ps) + interval '1 month - 1 day')::date);
    lys  := (s - interval '1 year')::date;
    lye  := (e - interval '1 year')::date;

  else -- ytd
    s    := date_trunc('year', p_report_date)::date;
    span := e - s;
    pe   := s - 1;
    ps   := pe - span;
    lys  := (s - interval '1 year')::date;
    lye  := (e - interval '1 year')::date;
  end if;

  return next;
end;
$fn$;

-- ROWS 1, and it matters. A set-returning function is estimated at 1000 rows
-- by default, and every report RPC joins this one as `cross join w` -- so the
-- planner multiplied every downstream estimate by 1000 and picked plans for a
-- query that does not exist. The hand-written CTE this replaced was a single
-- row the planner could see. Measured: wow_kpi_compare went from timing out
-- past 60s back to sub-second once this was set.
alter function public.wow_window(date, text) rows 1;
alter function public.wow_window(date, text) parallel safe;

revoke all on function public.wow_window(date, text) from public, anon;
grant execute on function public.wow_window(date, text) to authenticated, service_role;

comment on function public.wow_window(date, text) is
  'The single window definition behind every Week over Week RPC: given a report date and a grain (day|week|month|ytd) returns the current, prior and last-year windows. Month and YTD are TO-DATE -- a partial month compared against a complete one reads as a collapse every time. YTD''s prior window is the equal-length window ending Dec 31, not last year''s YTD, which the LY columns already hold. Day and week align last year on 364 days (same weekday); month and YTD align on the calendar date.';


-- Point every report RPC at wow_window, and give each one a p_grain argument.
--
-- Done by rewriting the DEPLOYED definition rather than retyping the bodies:
-- wow_paid_media alone is ~130 lines that four earlier migrations have already
-- patched in place, so the text in this repo is not what is running. Retyping
-- it from the files would silently revert those fixes. This reads what is
-- actually deployed, changes the two things that must change, and puts it
-- back.
--
-- It is idempotent (a function that already has p_grain is skipped) and it
-- refuses to guess: if the window CTE is not found exactly once, the whole
-- migration raises rather than leaving half the report on a different
-- definition of "last week" than the other half.
do $mig$
declare
  fn        text;
  args      text;
  oldsig    text;
  newsig    text;
  def       text;
  newdef    text;
  argopen   int;
  argclose  int;
  hits      int;
  old_acl   aclitem[];
  a         aclitem;
  grantee   text;
  changed   int := 0;
begin
  foreach fn in array array[
    'wow_report',
    'wow_kpi_compare',
    'wow_funnel',
    'wow_landing_pages',
    'wow_discount_codes',
    'wow_paid_media',
    'wow_paid_media_not_synced',
    'wow_paid_media_reality'
  ]
  loop
    select pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid), p.proacl
      into args, def, old_acl
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = fn
       and pg_get_function_identity_arguments(p.oid) not like '%p_grain%'
     order by p.oid
     limit 1;

    if not found then
      raise notice 'wow grain: %(...) already carries p_grain, or is absent -- skipping', fn;
      continue;
    end if;

    -- 1. The window CTE. Every one of these functions opens with a `w as (...)`
    --    holding nothing but date arithmetic -- no nested parentheses -- which
    --    is why a non-nesting match is safe here and is asserted, not assumed.
    hits := (select count(*) from regexp_matches(def, '\mw as \([^()]*\)', 'g'));
    if hits <> 1 then
      raise exception 'wow grain: %(%) has % window CTEs, expected exactly 1 -- refusing to guess',
        fn, args, hits;
    end if;

    newdef := regexp_replace(
      def,
      '\mw as \([^()]*\)',
      'w as (select * from public.wow_window(p_report_date, p_grain))'
    );

    -- 2. The signature. The first '(' in a CREATE FUNCTION text opens the
    --    argument list, and none of these argument lists contain parentheses,
    --    so the first ')' after it closes the list.
    argopen  := position('(' in newdef);
    argclose := argopen + position(')' in substr(newdef, argopen)) - 1;
    if argopen = 0 or argclose <= argopen then
      raise exception 'wow grain: could not locate the argument list of %(%)', fn, args;
    end if;
    newdef := substr(newdef, 1, argclose - 1)
              || ', p_grain text DEFAULT ''week''::text'
              || substr(newdef, argclose);

    oldsig := format('public.%I(%s)', fn, args);
    newsig := format('public.%I(%s, p_grain text)', fn, args);

    -- Drop before create: the old signature takes a default too, so leaving it
    -- in place would make wow_report(p_report_date := x) ambiguous rather than
    -- resolving to the new one. Inside this DO block, so a failure below rolls
    -- the drop back with it.
    execute format('drop function %s', oldsig);
    execute newdef;

    -- Reproduce the previous grants exactly. These functions do NOT share one
    -- ACL -- wow_report is revoked from anon and PUBLIC while the others are
    -- not -- so re-granting them all alike would quietly widen seven functions.
    execute format('revoke all on function %s from public', newsig);
    if old_acl is null then
      execute format('grant execute on function %s to public', newsig);
    else
      foreach a in array old_acl loop
        grantee := split_part(a::text, '=', 1);
        if grantee = '' then
          execute format('grant execute on function %s to public', newsig);
        else
          execute format('grant execute on function %s to %I', newsig, grantee);
        end if;
      end loop;
    end if;

    changed := changed + 1;
    raise notice 'wow grain: % is now grain-aware', newsig;
  end loop;

  raise notice 'wow grain: % function(s) rewritten', changed;
end
$mig$;


-- The written half of the report is per grain as well.
--
-- Commentary on a single day is not commentary on the year to date, and the
-- table was keyed (company, report_date) alone -- so opening the daily view
-- and saving would have overwritten the week's notes for the same date with
-- whatever the day's notes said. Existing rows are all weekly, which is what
-- the default backfills them as.
alter table public.wow_report_entries
  add column if not exists grain text not null default 'week';

alter table public.wow_report_entries
  drop constraint if exists wow_report_entries_grain_chk;
alter table public.wow_report_entries
  add constraint wow_report_entries_grain_chk
  check (grain in ('day', 'week', 'month', 'ytd'));

-- Replace the old two-column uniqueness with the three-column one. Dropping
-- the constraint takes its index with it, so the new index has to exist for
-- the page's upsert (on conflict company_entity_id, report_date, grain) to
-- have something to conflict against.
create unique index if not exists wow_report_entries_co_date_grain_key
  on public.wow_report_entries (company_entity_id, report_date, grain);

alter table public.wow_report_entries
  drop constraint if exists wow_report_entries_company_entity_id_report_date_key;

comment on column public.wow_report_entries.grain is
  'Which period the written notes belong to: day | week | month | ytd. Part of the row key -- a day''s commentary and a week''s commentary for the same report date are different documents. Rows predating the grain selector are week.';
