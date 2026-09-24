-- Finish the business-timezone sweep that 20260918120000 started, so a company
-- outside Pacific can be onboarded.
--
-- 20260918120000 taught silo_business_today()/_yesterday() to read the active
-- company's `company_settings.business_timezone`, then REFUSED every timezone
-- but Pacific at onboarding, because other sites still computed the day
-- boundary in Pacific on their own. Measured on production 2026-09-24 before
-- writing this, those sites were:
--
--   functions  check_publication_after_baselines, check_seo_measurement_window,
--              seo_baseline_conflicts, seo_follow_up_window,
--              forecast_candidate_cycles, record_forecast_candidate_run,
--              record_forecast_method_run,
--              refresh_sales_verification_store_comp_summary
--   views      calendar_events_v (live-session slots), forecast_candidate_ledger_v
--   table      forecast_candidate_ledger: the frozen_days_into_horizon
--              generated column and the forecast_ledger_frozen_before_outcome
--              CHECK
--
-- plus sync scripts and one browser module (see "What deliberately stays").
-- The database fixes are split by area so each database suite can load the
-- part it covers: 130000 (this file: the one helper), 130100 (SEO), 130200
-- (forecast ledger), 130300 (store comp summary, Org Calendar), and LAST
-- 130400, which widens onboarding's allowlist -- so a partial apply can never
-- accept a timezone that some site does not honour yet.
--
-- ── One definition ─────────────────────────────────────────────────────────
-- `silo_company_timezone(company)` is the ONE place the Pacific fallback is
-- written. Everything that needs a company's day boundary asks it, including
-- `silo_business_timezone()`, which now delegates to it for the active company.
-- verify_v2_schema.sql fails CRITICAL if 'America/Los_Angeles' reappears in any
-- other public function or view body -- the same guard the `'online'` channel
-- literal has.
--
-- The fallback is for a company with NO company_settings row (every company
-- founded before 20260918120000 except the two that were backfilled) and for
-- a null company. Both are Pacific today, so every existing number is
-- unchanged: this migration changes behaviour only for a company whose stored
-- timezone is not Pacific, and until now no such company could exist.
--
-- ── Why the forecast ledger stores its timezone on the ROW ─────────────────
-- A CHECK constraint and a STORED generated column cannot look anything up:
-- both must be immutable expressions of the row itself. So the ledger gains
-- `business_timezone`, stamped at insert from the company's setting by a
-- BEFORE INSERT trigger (whatever a writer passes is overwritten), and both the
-- CHECK and the generated column read it. That is also the right semantics for
-- an append-only ledger: a frozen forecast was judged in the calendar that
-- applied when it was written, and a company changing its timezone later must
-- not re-describe forecasts already made -- the same reason candidate_spec is
-- on the row. The append-only trigger compares the whole row, so the column
-- cannot be edited afterwards either. Existing rows are backfilled Pacific,
-- which is what they were computed in.
--
-- ── What deliberately stays ────────────────────────────────────────────────
-- * `sales_by_day.day_date` is already the SHOP's local date (the sync slices
--   Shopify's own offset-carrying created_at), so an Eastern store's sales were
--   never filed on Pacific days.
-- * Five SCRIPT sites keep reasoning in Pacific ON PURPOSE -- the Shopify sync's
--   forced yesterday/today rebuild, the ad-platform window end, the Search
--   Console window (Google's own days are Pacific), the sales freshness alarm,
--   and v2/daily-trend-kpis.js's "in progress" label. Pacific is the WESTERNMOST
--   supported zone, so a Pacific "today" is never ahead of any supported
--   company's today and each of those is conservative, never wrong: the forced
--   rebuild still covers the company's own yesterday, a window never writes a
--   day that has not finished, a partial day is never labelled complete.
--   scripts/tests/business-timezone-westmost.test.mjs pins that assumption to
--   the supported list.
-- * The nightly cron (08:30 UTC) is after local midnight in every US MAINLAND
--   timezone, which is why exactly those are added below. Alaska and Hawaii
--   are not: 08:30 UTC is still the previous evening there, and adding them is
--   a scheduling change first.
-- * `launch_calendar.time_zone` / `launch_channel_items.time_zone` default to
--   Pacific: a per-row DISPLAY timezone for a launch's time of day that a
--   person picks, not a day boundary SILO computes.
-- * Saved reports that name Pacific are all company-scoped Baseballism rows
--   (17, none `system`), i.e. Baseballism's own reports in Baseballism's own
--   timezone.

-- ── 1. The one definition ──────────────────────────────────────────────────
create or replace function public.silo_company_timezone(p_company_entity_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  -- Service-role syncs and migrations have no auth.uid() and act for every
  -- company. A signed-in caller may ask only about a company they belong to:
  -- a company's timezone is not secret, but the answer confirms the id is a
  -- real tenant, and nothing legitimate asks about someone else's.
  -- Nested rather than one AND chain: PL/pgSQL plans a condition as a whole,
  -- so the membership lookup is only reached (and only costs anything) for the
  -- rare caller asking about a company other than their active one.
  if p_company_entity_id is not null
     and auth.uid() is not null
     and p_company_entity_id is distinct from public.active_company_id()
  then
    if not exists (select 1 from public.entity_memberships m
                    where m.entity_id = p_company_entity_id
                      and m.user_id = auth.uid()) then
      raise exception 'silo_company_timezone: not a member of company %', p_company_entity_id
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  select cs.business_timezone into v_tz
    from public.company_settings cs
   where cs.company_entity_id = p_company_entity_id;

  return coalesce(v_tz, 'America/Los_Angeles');
end;
$$;

comment on function public.silo_company_timezone(uuid) is
  'A company''s business timezone (company_settings.business_timezone), falling back to Pacific when the company has no settings row or is null. THE one place that fallback is written -- verify_v2_schema.sql fails if the literal appears in any other public function or view. SECURITY DEFINER to read company_settings; a signed-in caller may only ask about a company they belong to. See 20260924130000.';

revoke execute on function public.silo_company_timezone(uuid) from public, anon;
grant execute on function public.silo_company_timezone(uuid) to authenticated, service_role;

-- Same signature, same grants, same answer for every existing caller.
create or replace function public.silo_business_timezone()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select public.silo_company_timezone(public.active_company_id());
$$;
