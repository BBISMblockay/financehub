-- Forward-corrective for 20260909260000. seo_baseline_conflicts() compares a
-- `date` against a `timestamptz` cast with `::date`, and that cast reads the
-- SESSION TimeZone -- while the function is declared IMMUTABLE, which promises
-- the opposite.
--
-- Not theoretical. Measured on this database (2026-09-09):
--
--   set time zone 'UTC';                  '2026-09-01T02:00:00Z'::date => 2026-09-01
--   set time zone 'America/Los_Angeles';  same value           ::date => 2026-08-31
--
-- A publication at 02:00 UTC on the 1st is 19:00 Pacific on the 31st. Under one
-- session a baseline ending 2026-08-31 conflicts; under another it does not.
-- The boundary the whole invariant rests on moved with a connection setting,
-- and because the function is IMMUTABLE the planner is entitled to fold and
-- cache a result computed under one timezone and reuse it under another.
--
-- SILO's business day is PACIFIC and this repo already says so out loud --
-- silo_business_today() / silo_business_yesterday() exist precisely because
-- `current_date` is UTC and is a day ahead from 17:00 Pacific onward. A
-- publication timestamp is a business event, so the date it falls on is the
-- Pacific date, not whatever the connection happens to be set to.
--
-- `timestamptz AT TIME ZONE '<literal>'` is genuinely immutable (the zone is a
-- constant, not a setting), so the IMMUTABLE marking becomes true rather than
-- being downgraded to STABLE -- which matters, since this is called from
-- triggers on both sides of the invariant and inside a WHERE clause.
--
-- Pacific is hardcoded here for the same reason it is hardcoded in
-- silo_business_today(): a tenant in another timezone needs this to read from
-- their company record, and that is a wider change than this fix.

create or replace function public.seo_baseline_conflicts(
  p_period_end date,
  p_published timestamptz
) returns boolean
language sql
immutable
as $$
  select p_published is not null
     and p_period_end >= (p_published at time zone 'America/Los_Angeles')::date;
$$;

comment on function public.seo_baseline_conflicts(date, timestamptz) is
  'True when a baseline window ending p_period_end cannot be a baseline for a '
  'change published at p_published. Two deliberate choices: >=, because a '
  'daily window ending on the publication date contains hours on both sides of '
  'the change; and an explicit America/Los_Angeles conversion rather than '
  '::date, because ::date reads the session TimeZone and would move the '
  'boundary by a day between connections -- SILO''s business day is Pacific '
  '(see silo_business_today()).';
