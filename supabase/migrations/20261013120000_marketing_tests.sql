-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing tests: the one record SILO did not have.
--
-- Marketing already has the pieces around a test. `launch_channel_items` is the
-- schedule (channel, item, type, date, time, timezone, status, priority, owner,
-- copy/creative-needed, link; `launch_id` is nullable, so an item needs no
-- launch), `launch_tasks` hangs work off those items, `ad_ideas` is the idea
-- bank with its frozen baseline, and the v3 creative workspaces are where the
-- numbers are read. What nothing held was the test itself: what was being
-- tried, against what, over which window, judged on which metric, and what was
-- learned. That lived in spreadsheets and Slack, so a finished test left no
-- record anyone could search.
--
-- This migration adds that row and NOTHING ELSE. It does not re-implement the
-- schedule, and it does not store measurements: `control_value` /
-- `variant_value` are what the reader wrote down off the dashboard they name in
-- `metric_note`, not a figure this table computes. SILO's numbers stay in the
-- reports that already own them.
--
-- TWO RULES CARRY THE WEIGHT.
--
-- 1. THE DESIGN FREEZES WHEN THE TEST STARTS. Once a test has left `planned`,
--    the trigger refuses an edit to `hypothesis`, `element`, `control`,
--    `variant` or `metric`. This is Ad Studio's lesson (`ad_ideas`'s frozen
--    `baseline_snapshot`) applied one step later: a metric chosen after the
--    numbers are in is a metric chosen BY the numbers, and a hypothesis
--    rewritten at the end always turns out to have been right. Re-running with
--    a different measure is a new test, which also keeps the record of what the
--    first one was actually judged on. The freeze reads `started_at` -- stamped
--    the first time the test runs and never cleared -- rather than the current
--    status, because a status check would be thawed by moving the test back to
--    `planned` for one update. The window (`starts_on` / `ends_on`)
--    stays editable on purpose: extending a read is ordinary operations, and
--    both dates are visible on the row, so a stretched window shows.
--
-- 2. A CONCLUDED TEST MUST SAY WHAT HAPPENED. `concluded` requires both an
--    `outcome` and a non-empty `result_summary` (CHECK, not UI), because a test
--    closed with an empty result is indistinguishable from one nobody read, and
--    the learning is the only part of this row that outlives the campaign.
--    `outcome` cannot be set in any other status, so "we think it is winning"
--    cannot be filed as a result.
--
-- THE LINK TO THE SCHEDULE is a column on `launch_channel_items`, not a copy of
-- it: `marketing_test_id` says which test an already-scheduled item serves. The
-- foreign key is COMPOSITE -- (marketing_test_id, company_entity_id) against
-- marketing_tests (id, company_entity_id) -- so an item can only ever name a
-- test in its own company, by construction rather than by a trigger anyone can
-- forget. `on delete set null (marketing_test_id)` unlinks the items when a
-- test is deleted; it must never cascade, because the scheduled post is real
-- work that outlives the experiment it was borrowed for. Note the MATCH SIMPLE
-- semantics: `launch_channel_items.company_entity_id` is nullable (it is
-- stamped by trigger on insert), and a row whose company is NULL skips the
-- check entirely -- such a row is unreadable under RLS anyway, since every
-- policy tests equality against active_company_id().
--
-- ACCESS follows the launch calendar and the idea bank: a shared board. Any
-- member of the company reads, adds and moves tests; only the creator or an
-- admin deletes one. Marketing is department `marketing` with profiles.role
-- `admin` or `user` (13 of 14 on 2026-10-13), so a narrower gate would hide
-- this from the people it is for -- the same finding as PR #956, which took the
-- exec gate off Ad Studio's nav row.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.marketing_tests (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  -- The channel vocabulary is launch_channel_items' own (organic / email / sms
  -- / meta / other are what its 33 rows carry on 2026-10-13), plus the ones
  -- SILO already ingests elsewhere. That table has no CHECK of its own and is
  -- not given one here: it has other writers, and tightening a column under
  -- them is how a launch form starts failing to save.
  channel text not null check (channel in
    ('meta', 'google', 'tiktok', 'email', 'sms', 'organic', 'website', 'other')),
  -- What is actually varying. Separate from `channel` because "a creative test
  -- on email" and "a send-time test on email" compare different things.
  element text not null check (element in
    ('creative', 'copy', 'audience', 'offer', 'landing_page', 'send_time',
     'subject_line', 'product', 'other')),
  hypothesis text not null check (length(btrim(hypothesis)) between 1 and 2000),
  control text check (control is null or length(control) <= 500),
  variant text check (variant is null or length(variant) <= 500),
  -- The measure the test is judged on, named BEFORE it runs (see rule 1).
  metric text not null check (metric in
    ('roas', 'cpa', 'ctr', 'cvr', 'thruplay_rate', 'open_rate', 'click_rate',
     'revenue', 'orders', 'subscribers', 'other')),
  -- Where the number is read: a dashboard, a report, a platform view. Free
  -- text, because the reader knows and this table does not compute it.
  metric_note text check (metric_note is null or length(metric_note) <= 500),
  starts_on date,
  ends_on date,
  status text not null default 'planned'
    check (status in ('planned', 'running', 'reading', 'concluded', 'abandoned')),
  outcome text check (outcome in ('win', 'loss', 'inconclusive')),
  -- What the reader wrote down, NOT a computed figure. NULL is "not measured",
  -- never zero -- the same rule the marketing tables follow.
  control_value numeric,
  variant_value numeric,
  result_summary text check (result_summary is null or length(result_summary) <= 5000),
  launch_id uuid references public.launch_calendar(id) on delete set null,
  ad_idea_id uuid references public.ad_ideas(id) on delete set null,
  notes text check (notes is null or length(notes) <= 5000),
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluded_by uuid references auth.users(id),
  concluded_at timestamptz,
  -- When this test FIRST reached running / reading / concluded, stamped by the
  -- trigger and never cleared. It is what the design freeze reads, so moving a
  -- test back to `planned` cannot thaw it. Distinct from `starts_on`, which is
  -- the date a person says the test runs from: one is a fact about the row,
  -- the other is a claim about the campaign, and the freeze must not depend on
  -- a date anybody can retype.
  started_at timestamptz,
  constraint marketing_tests_window_ordered
    check (starts_on is null or ends_on is null or ends_on >= starts_on),
  -- A test that is running, being read, or finished has a start date; only a
  -- plan or an abandoned plan may have none.
  constraint marketing_tests_started_has_start_date
    check (status in ('planned', 'abandoned') or starts_on is not null),
  -- Rule 2, in two halves: an outcome belongs only to a concluded test, and a
  -- concluded test carries both an outcome and what was learned.
  constraint marketing_tests_outcome_only_when_concluded
    check (outcome is null or status = 'concluded'),
  constraint marketing_tests_concluded_is_answered
    check (status <> 'concluded'
           or (outcome is not null and length(btrim(coalesce(result_summary, ''))) > 0)),
  -- The composite target the schedule's foreign key points at, so a channel
  -- item can only reference a test inside its own company.
  constraint marketing_tests_company_key unique (id, company_entity_id)
);

-- starts_on before created_at, nulls last: the page lists newest-first and a
-- plan with no date yet belongs at the end, not at the top. (A
-- coalesce(starts_on, created_at::date) expression index would not build:
-- timestamptz -> date depends on the session TimeZone, so it is not immutable.)
create index if not exists marketing_tests_company_status_idx
  on public.marketing_tests (company_entity_id, status, starts_on desc nulls last, created_at desc);
create index if not exists marketing_tests_launch_idx
  on public.marketing_tests (launch_id) where launch_id is not null;
create index if not exists marketing_tests_ad_idea_idx
  on public.marketing_tests (ad_idea_id) where ad_idea_id is not null;

create or replace function public.marketing_tests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.company_entity_id is distinct from old.company_entity_id then
      raise exception 'marketing_tests: a test cannot move to another company';
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'marketing_tests: created_by / created_at are fixed';
    end if;
    -- Rule 1. Once the test has RUN its design is settled: the metric is
    -- frozen so it cannot be chosen by the result, and the hypothesis so it
    -- cannot be rewritten to match one. The test is `old.started_at`, not
    -- `old.status`, on purpose: a status check would let the design be thawed
    -- by moving the test back to `planned` for one update and then forward
    -- again, which is two clicks and leaves no trace. started_at is never
    -- cleared, so that route is closed. The window is deliberately NOT frozen.
    if old.started_at is not null then
      if new.hypothesis is distinct from old.hypothesis
         or new.element is distinct from old.element
         or new.control is distinct from old.control
         or new.variant is distinct from old.variant
         or new.metric is distinct from old.metric then
        raise exception 'marketing_tests: the design (hypothesis, element, control, variant, metric) is frozen once a test has started -- start a new test to change what is measured';
      end if;
    end if;
  end if;
  -- started_at is stamped the first time a test actually runs, and kept
  -- forever after. A plan that is abandoned without running is NOT stamped:
  -- nothing was measured, so there is no result its design could be fitted to.
  if new.status in ('running', 'reading', 'concluded') then
    new.started_at := coalesce(case when tg_op = 'UPDATE' then old.started_at end, now());
  else
    new.started_at := case when tg_op = 'UPDATE' then old.started_at end;
  end if;
  -- concluded_by / concluded_at are stamped here, never taken from the client,
  -- and cleared if a test is reopened so a reopened test cannot show a
  -- conclusion nobody reached.
  if new.status = 'concluded' and (tg_op = 'INSERT' or old.status is distinct from 'concluded') then
    new.concluded_by := auth.uid();
    new.concluded_at := now();
  elsif new.status <> 'concluded' then
    new.concluded_by := null;
    new.concluded_at := null;
  else
    new.concluded_by := old.concluded_by;
    new.concluded_at := old.concluded_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_marketing_tests_guard on public.marketing_tests;
create trigger trg_marketing_tests_guard before insert or update on public.marketing_tests
  for each row execute function public.marketing_tests_guard();

alter table public.marketing_tests enable row level security;
revoke all on public.marketing_tests from anon;

drop policy if exists marketing_tests_select on public.marketing_tests;
create policy marketing_tests_select on public.marketing_tests for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists marketing_tests_insert on public.marketing_tests;
create policy marketing_tests_insert on public.marketing_tests for insert to authenticated
  with check (company_entity_id = public.active_company_id() and created_by = auth.uid());

drop policy if exists marketing_tests_update on public.marketing_tests;
create policy marketing_tests_update on public.marketing_tests for update to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop policy if exists marketing_tests_delete on public.marketing_tests;
create policy marketing_tests_delete on public.marketing_tests for delete to authenticated
  using (company_entity_id = public.active_company_id()
         and (created_by = auth.uid() or public.is_admin_user()));

comment on table public.marketing_tests is
  'One marketing test: what was tried (element, control, variant), the '
  'hypothesis, the metric it is judged on, the read window, and -- once '
  'concluded -- the outcome and what was learned. Backs /v2/marketing-ops.html. '
  'The design (hypothesis, element, control, variant, metric) FREEZES the first '
  'time the test runs (started_at, which is never cleared, so moving it back to '
  '`planned` cannot thaw it), so the measure cannot be chosen by the result, and '
  'a concluded test must carry an outcome and a non-empty result_summary. '
  'control_value / variant_value are what the reader recorded off the dashboard '
  'named in metric_note, never a figure this table computes; NULL means not '
  'measured. Scheduled items join FROM launch_channel_items.marketing_test_id. '
  'Shared board: any company member adds and moves tests, delete is '
  'creator-or-admin.';

comment on column public.marketing_tests.started_at is
  'When this test first reached running / reading / concluded. Stamped by the '
  'trigger, never cleared, never taken from the client: it is what the design '
  'freeze reads. Not starts_on, which is the date a person says the test runs '
  'from.';
comment on column public.marketing_tests.metric_note is
  'Where the number is read (a v3 dashboard, a report, a platform view). Free '
  'text: the reader knows, and this table computes nothing.';
comment on column public.marketing_tests.control_value is
  'The reader''s recorded value for the control, in whatever unit `metric` '
  'implies. NULL = not measured, never zero.';

-- ── The link to the schedule SILO already has ───────────────────────────────
-- A column on the existing table, so a test borrows scheduled items instead of
-- holding a second copy of the schedule. Other writers (v2/launch-calendar.html,
-- v2/tasks.html, v2/marketing-overview.html) are unaffected: the column is
-- nullable, and the two pages that read named columns do not select it.
alter table public.launch_channel_items
  add column if not exists marketing_test_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'launch_channel_items_marketing_test_fkey') then
    alter table public.launch_channel_items
      add constraint launch_channel_items_marketing_test_fkey
      foreign key (marketing_test_id, company_entity_id)
      references public.marketing_tests (id, company_entity_id)
      on delete set null (marketing_test_id);
  end if;
end $$;

create index if not exists launch_channel_items_marketing_test_idx
  on public.launch_channel_items (marketing_test_id) where marketing_test_id is not null;

comment on column public.launch_channel_items.marketing_test_id is
  'The marketing_tests row this scheduled item serves, or NULL. The foreign '
  'key is composite with company_entity_id, so an item can only name a test in '
  'its own company; deleting a test unlinks the items and never deletes them.';

select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords, is_hidden)
values
  ('marketing_tests', 'r', '[]'::jsonb,
   'Marketing tests: one row per test the marketing team ran -- channel, what '
   'varied (element), control vs variant, the hypothesis, the metric it was '
   'judged on, the read window, and for a concluded test the outcome '
   '(win/loss/inconclusive) with what was learned (result_summary). '
   'control_value / variant_value are values a person recorded off a '
   'dashboard, NOT measurements SILO computed, and NULL means not measured. '
   'Joins: launch_channel_items.marketing_test_id (the scheduled posts and ads '
   'carrying the test), launch_id, ad_idea_id. A planned or running test is an '
   'intention, never evidence of performance.',
   array['marketing tests','ab test','a/b test','experiment','test results','creative testing','hypothesis','learnings'],
   false)
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%Marketing tests: one row per test%'
        then public.silo_chat_schema_catalog.description
        else excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      is_hidden = excluded.is_hidden,
      updated_at = now();

select public.refresh_chat_schema_catalog();
