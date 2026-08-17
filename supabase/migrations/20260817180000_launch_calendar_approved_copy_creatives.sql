-- 20260817180000_launch_calendar_approved_copy_creatives.sql
--
-- Benny's release-brief feedback: "Approved copy and approved creatives is a
-- separate field from do's and don'ts" — the brief should carry six marketing
-- fields, not four:
--
--   1. Approved Copy        <- new (this migration)
--   2. Copy Do's            <- already shipped 20260814150000
--   3. Copy Don'ts          <- already shipped 20260814150000
--   4. Approved Creatives   <- new (this migration)
--   5. Creative Do's        <- already shipped 20260814150000
--   6. Creative Don'ts      <- already shipped 20260814150000
--
-- The do's/don'ts columns hold *guardrails* ("never call it a restock").
-- These two hold the *approved asset itself* — the signed-off headline/caption
-- copy, and the approved creative set or a link to it. Separate fields because
-- they are written by different people at different times: the approved copy
-- lands once from marketing, the guardrails are standing rules.
--
-- Idempotent, additive only. No backfill: existing launches keep NULL and the
-- fields simply render empty until someone fills them in.

alter table public.launch_calendar
  add column if not exists approved_copy      text,
  add column if not exists approved_creatives text;

comment on column public.launch_calendar.approved_copy is
  'Signed-off launch copy (headlines, captions, key lines). Distinct from copy_dos/copy_donts, which are standing guardrails.';

comment on column public.launch_calendar.approved_creatives is
  'Signed-off creative set, or a link/reference to it. Distinct from creative_dos/creative_donts, which are standing guardrails.';
