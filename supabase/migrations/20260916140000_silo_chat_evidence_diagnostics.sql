-- Ask SILO: bounded diagnostic evidence, and a coverage claim that cannot go
-- stale.
--
-- WHY. Two answers traced on 2026-09-16 (silo_chat_audit_log
-- c0b642ca-3bc4-4703-be94-995cb7f0a7b9 and 7c90b2cd-84a2-4ce8-888f-a2186ba0927c)
-- published figures under labels their SQL never supported. Establishing that
-- from the audit log meant re-running every statement by hand against live
-- data, because the log stored the QUESTION, the STATEMENTS and the ANSWER and
-- nothing about what any statement returned or what schema guidance the model
-- had in front of it. Re-running answers what the database says today; synced
-- marketing data and historical attribution both move, so "today" is not the
-- evidence.
--
-- TWO CHANGES, both additive, neither touching business data.

-- ── 1. silo_chat_audit_log.diagnostics ─────────────────────────────────────
--
-- WHAT GOES IN IT (written by the silo-chat edge function, see
-- buildDiagnostics there): per query -- the statement, the evidence scope
-- derived from it, the row count, the duration, and the error text if it
-- failed; plus which relations were given full schema cards from the opening
-- question's keywords and which the model had to fetch mid-investigation.
--
-- WHAT DOES NOT: result rows. Not a sample, not the first row, not a hash of
-- one. A returned row is the business data RLS exists to scope, and a second
-- copy of it is a second place to get a policy right. Counts and shapes are
-- what diagnose a mislabelled figure; values are not needed for it, and the
-- edge function asserts this in its own test suite rather than leaving it as
-- an intention.
--
-- ACCESS: no new surface. This is a column on a row that already lands through
-- the caller's own JWT, under a select policy that is already
-- `company_entity_id = active_company_id() AND (created_by = auth.uid() OR
-- is_exec_or_owner())`. No new table, no new grant, no new reader, and nothing
-- here is readable across tenants that was not already.
--
-- SIZE: capped in the edge function BEFORE the insert (detail is shed in
-- order and what was shed is recorded), because an oversized payload would
-- fail the insert -- and a logging failure must never turn a good answer into
-- a failed request. The function also retries the insert without this column
-- if it is not there yet, so the function and this migration may be applied in
-- either order.
--
-- RETENTION: same as the rest of the row, deliberately. This table has no
-- update or delete policy at all -- an audit log that can be edited after the
-- fact is not one -- so a retention sweep would have to be a service-role job,
-- and inventing one here would be the first thing in this file that could
-- destroy a record. When retention is wanted it belongs in its own change,
-- covering the whole row rather than this column.
alter table public.silo_chat_audit_log
  add column if not exists diagnostics jsonb;

comment on column public.silo_chat_audit_log.diagnostics is
  'Bounded per-request diagnostics written by the silo-chat edge function: for each query, the statement, its derived evidence scope, row count, duration and error text; plus which relations were in the up-front schema slice versus fetched mid-request via describe_relations. NEVER contains result rows -- only outcomes and shapes. Size-capped before insert so a logging failure cannot fail an answer. Null on rows written before 20260916140000 and on any request whose diagnostics exceeded the cap entirely.';

-- The view carries an explicit column list, so a new column has to be named
-- into it or every reader keeps seeing the old shape with no error at all --
-- the same trap 20260916121000 documented for request_id. Appended at the END
-- because `create or replace view` can only add columns after the existing
-- ones.
create or replace view public.silo_chat_audit_log_v
with (security_invoker = true) as
select
  l.id,
  l.company_entity_id,
  l.created_by,
  p.name as created_by_name,
  p.email as created_by_email,
  l.question,
  l.answer,
  l.queries_run,
  l.tool_rounds,
  l.status,
  l.error_message,
  l.model,
  l.created_at,
  l.request_id,
  l.diagnostics
from public.silo_chat_audit_log l
left join public.profiles p on p.id = l.created_by;

revoke all on public.silo_chat_audit_log_v from anon;
grant select on public.silo_chat_audit_log_v to authenticated;

-- ── 2. A coverage claim stops being a sentence ─────────────────────────────
--
-- meta_ad_performance_daily's catalog card said: "COVERAGE: only about 7 weeks
-- of history (from 2026-07-08). Deep enough for questions about CURRENT
-- creative performance, far too shallow to compare past launches -- do not use
-- it for launch comps."
--
-- Measured on 2026-09-16: 415 days, 2025-07-28 through 2026-09-15. The card
-- was true when written and had quietly become an instruction to avoid a table
-- that holds more than a year of the exact history it forbids using.
--
-- The fix is NOT a fresher range. A hardcoded range is the defect -- it has no
-- way to notice that it aged, and the next one would age the same way on the
-- same silent schedule. So the card now says how to find out, and
-- describe_relations measures min/max of the day-grain column at request time
-- and returns it beside the card. Coverage becomes a measurement, not a memory.
--
-- Written out in full rather than patched with regexp_replace, so the stored
-- text is exactly what is reviewed here. Note the hazard that produced
-- 20260910150000 (a later migration replacing a description and dropping
-- caveats another had added): every sentence of the previous card other than
-- the coverage claim is preserved below, verbatim.
update public.silo_chat_schema_catalog set
  description = $d$Ad-level (not just campaign-level) Meta performance. Joins to meta_ad_creatives(ad_id, creative_id, thumbnail_url, body, title, object_type, effective_status) on ad_id for creative metadata. object_type observed values are SHARE (single image/link ad), VIDEO, and STATUS (text-only) -- not a literal image/video/carousel taxonomy. body is the ad copy, title is the headline. For actual visual design call view_ad_creative_image with the ad_id -- sparingly, only for the specific ads the question is about. Compute CPM as spend/impressions*1000 and CAC as spend/conversions. COVERAGE IS MEASURED, NEVER REMEMBERED: this card deliberately states no date range, because a range written here cannot notice that it has aged -- the one that used to be here understated this table by more than a year and was steering questions off it. Call describe_relations for this table, which reads min and max of day_date under your own access at request time, or run that min/max yourself. Never state how far back this goes, and never decline a historical comparison for lack of depth, without having measured it in this conversation.$d$
where relname = 'meta_ad_performance_daily';

-- The other half of the same trace. marketing_daily_totals_v is one row per
-- day across EVERY platform -- it has no platform, campaign or ad column at
-- all -- and a week's ad_spend from it ($118,945.91 for 24-30 Aug 2026) was
-- published as one platform's spend, then divided by that platform's own
-- attributed value. The edge function now derives and returns that fact with
-- the rows, which is the control; this sentence is the card saying the same
-- thing where someone reading the map will meet it.
update public.silo_chat_schema_catalog set
  description = $d$One row per day: total paid ad spend, impressions, clicks, platform-attributed conversions and value, plus GA4 sessions and site revenue. Use for spend trend over time. For true MER against Shopify ledger revenue use v_marketing_mer_daily instead. EVERY FIGURE HERE IS ALREADY COMBINED ACROSS PLATFORMS: there is no platform, campaign or ad column, so ad_spend is Meta plus Google plus TikTok together and cannot be attributed to any one of them however the question was asked. For a per-platform or per-campaign figure query marketing_kpis_daily, which carries both columns.$d$
where relname = 'marketing_daily_totals_v';

-- ── 3. Keep the catalog's auto-generated half honest ───────────────────────
--
-- silo_chat_audit_log and silo_chat_audit_log_v are both IN the catalog
-- (is_hidden = false), and both gained a column above, so the catalog's
-- generated column lists are now stale -- which verify_v2_schema.sql flags.
-- refresh_chat_schema_catalog() regenerates columns from pg_catalog and
-- PRESERVES curated description/keywords, so the two updates above survive it.
-- It must run AFTER them for the same reason it runs last everywhere else.
select public.refresh_chat_schema_catalog();
