-- Landing pages: continue where a run stopped, and stop accumulating pages
-- that are no longer in a day's top N.
--
-- Two functions, both needed by runLandingPagesSync, both SECURITY INVOKER.
--
-- WHY INVOKER MATTERS HERE, especially for the sweep. It DELETES rows, and it
-- takes the company id as an argument -- so if it were DEFINER, any
-- authenticated user could pass another tenant's uuid and delete their landing
-- page history. As INVOKER it runs under the caller's own RLS, and
-- shopify_landing_pages_daily has exactly one policy: a SELECT scoped to
-- active_company_id(). There is no client insert, update or delete policy at
-- all. So for a browser user this function is a no-op by construction rather
-- than by argument checking, and the nightly sync (service role, bypasses RLS)
-- is the only thing that can actually delete. Do NOT "fix" either of these to
-- DEFINER.

-- ── 1. Which days do we already have? ───────────────────────────────────────
-- Needed because a resumable backfill has to know where to resume FROM.
-- Returning distinct DAYS rather than rows is the whole point: a 730-day
-- window is ~180,000 rows and about 730 useful facts, and shipping the rows to
-- Node to distinct them there would move ~20MB to answer a question Postgres
-- can answer from the index.
create or replace function public.shopify_landing_pages_covered_days(
  p_company_entity_id uuid,
  p_shop_domain       text,
  p_since             date,
  p_until             date
) returns setof date
language sql
stable
security invoker
set search_path = public
as $$
  select distinct day_date
  from public.shopify_landing_pages_daily
  where company_entity_id = p_company_entity_id
    and shop_domain       = p_shop_domain
    and day_date >= p_since
    and day_date <= p_until
  order by day_date
$$;

comment on function public.shopify_landing_pages_covered_days(uuid, text, date, date) is
  'Distinct days already stored for one shop in a window. Lets a landing-page '
  'backfill resume where it stopped instead of restarting at yesterday. '
  'SECURITY INVOKER -- a browser caller sees only their own company''s days, '
  'via the table''s select policy.';

-- ── 2. Remove paths a day no longer has ─────────────────────────────────────
-- The upsert alone cannot do this. Each day stores its top N landing paths;
-- when Shopify RESTATES a day (it revises analytics for several days after the
-- fact) a path that has dropped out of the top N is simply absent from the new
-- result -- and an upsert never removes what it is not given. So the old row
-- survived forever, keeping a stale rank_in_day and stale session counts, and
-- "the top 250 pages on 2026-08-01" quietly became "every page that has ever
-- been in the top 250 on 2026-08-01". Ranks would collide and the day's row
-- count would only ever grow.
--
-- THE GUARD IS THE IMPORTANT PART. An empty keep-list must never mean "delete
-- everything for this day" -- that is precisely the shape of a bad fetch (a
-- transport hiccup returning zero rows), and treating it as a restatement to
-- zero would erase a real day's history on a transient error. It raises
-- instead. The caller ALSO refuses to sweep a day that returned no rows; this
-- is the second lock on the same door, because the caller's guard is one edit
-- away from being wrong and this one is not.
create or replace function public.shopify_landing_pages_sweep_day(
  p_company_entity_id uuid,
  p_shop_domain       text,
  p_day               date,
  p_keep_paths        text[]
) returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_keep_paths is null or coalesce(array_length(p_keep_paths, 1), 0) = 0 then
    raise exception
      'shopify_landing_pages_sweep_day: refusing to sweep % with an empty keep-list; '
      'a day that returned no rows is a suspect fetch, not a restatement to zero', p_day
      using errcode = 'check_violation';
  end if;

  delete from public.shopify_landing_pages_daily
  where company_entity_id = p_company_entity_id
    and shop_domain       = p_shop_domain
    and day_date          = p_day
    and landing_page_path <> all (p_keep_paths);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.shopify_landing_pages_sweep_day(uuid, text, date, text[]) is
  'Delete rows for one day whose landing_page_path is not in the freshly '
  'fetched top-N keep-list, so a restated day does not accumulate pages that '
  'have dropped out of it. RAISES on an empty keep-list: no rows is a suspect '
  'fetch, never a restatement to zero. SECURITY INVOKER -- the table has no '
  'client write policy, so only the service-role sync can actually delete.';

-- GRANTS: `revoke ... from public` IS NOT ENOUGH, and this was verified rather
-- than assumed. Supabase's default privileges on the `public` schema re-grant
-- EXECUTE to anon and authenticated on any newly created function, silently --
-- checked immediately after the first apply of this migration, and both roles
-- could execute the SWEEP. That is the same hole 20260904330000 closed for
-- chat_run_readonly_query, and the reason verify_v2_schema.sql now checks it
-- there. The roles have to be named explicitly.
--
-- The sweep would be a no-op for a browser user anyway, because
-- shopify_landing_pages_daily has no client write policy -- but "it happens to
-- be harmless today" is not an access decision. A write policy added later for
-- some unrelated reason must not retroactively hand every logged-in user a
-- cross-tenant delete path through a function that takes a company id as an
-- argument.
revoke all on function public.shopify_landing_pages_covered_days(uuid, text, date, date) from public, anon;
revoke all on function public.shopify_landing_pages_sweep_day(uuid, text, date, text[]) from public, anon, authenticated;
grant execute on function public.shopify_landing_pages_covered_days(uuid, text, date, date) to authenticated;

update public.silo_chat_schema_catalog
set description =
  'Top ~250 landing-page paths per shop per day, with the storefront funnel '
  'counts for each. rank_in_day is that day''s rank; is_truncated marks a day '
  'that filled the top-N cap, so its tail is not represented. Days are '
  'restated by Shopify for several days after the fact, and a restated day is '
  'swept of paths that dropped out of its top N -- so a day''s rows are the '
  'top N AS OF the last sync, not everything ever seen. Coverage is not '
  'guaranteed continuous: check sync_jobs for landing_pages_sync rows, whose '
  'result carries days_requested/days_fetched/days_written and a complete '
  'flag.',
    updated_at = now()
where relname = 'shopify_landing_pages_daily';

select public.refresh_chat_schema_catalog();
