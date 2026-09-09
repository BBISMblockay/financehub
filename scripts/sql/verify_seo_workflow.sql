-- Exercises the two invariants of the SEO workflow against a REAL database,
-- then rolls everything back.
--
-- Run in the Supabase SQL editor (or any service-role psql session). It ends
-- by RAISING, which is not a failure -- that is what forces the rollback, and
-- the exception message IS the report. Every line should read PASS.
--
-- Structural checks (RLS enabled, policies present, no client write policy on
-- the revision table) live in supabase/verify_v2_schema.sql. This file checks
-- BEHAVIOUR: constraints, triggers, and what the read model derives. It runs
-- as service role, so it does not exercise the RLS policies themselves --
-- approval enforcement is asserted structurally, and confirming it end to end
-- needs impersonation, the way the storage-isolation work was checked.
--
--   psql "$SUPABASE_DB_URL" -f scripts/sql/verify_seo_workflow.sql

do $test$
declare
  co   uuid := '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';  -- Baseballism
  proj uuid; task uuid; rev_count int; n int; ok boolean;
  out  text := E'\n';
begin
  insert into public.seo_projects (company_entity_id, name, objective)
  values (co, 'TEST project', 'invariant test') returning id into proj;

  insert into public.seo_tasks (company_entity_id, project_id, title, proposed_title)
  values (co, proj, 'TEST task', 'first title') returning id into task;

  -- INVARIANT 1. Approval is not publication. This is the one the whole shape
  -- of the schema exists to guarantee: there is no publication column to set.
  update public.seo_tasks set approval_status='approved', approved_at=now() where id=task;
  select is_published into ok from public.seo_tasks_v where id=task;
  out := out || case when ok is false then 'PASS' else 'FAIL' end
      || ' — approved task is NOT published' || E'\n';

  -- Revisions: the product_concepts pattern, one row per superseded state.
  select count(*) into rev_count from public.seo_task_revisions where task_id=task;
  select current_revision_number into n from public.seo_tasks where id=task;
  out := out || case when rev_count=1 and n=1 then 'PASS' else 'FAIL' end
      || ' — one revision recorded, counter now ' || n || E'\n';

  -- A patch that changes nothing must mint nothing, or history fills with noise.
  update public.seo_tasks set approval_status='approved' where id=task;
  select count(*) into rev_count from public.seo_task_revisions where task_id=task;
  out := out || case when rev_count=1 then 'PASS' else 'FAIL' end
      || ' — no-op update minted no revision (still ' || rev_count || ')' || E'\n';

  -- "Verified" must mean something. A verified_capture with nothing to verify
  -- against is a claim wearing a stronger word.
  begin
    insert into public.seo_task_publications (company_entity_id, task_id, published_at, method)
    values (co, task, now(), 'verified_capture');
    out := out || 'FAIL — verified_capture accepted with no inspection' || E'\n';
  exception when check_violation then
    out := out || 'PASS — verified_capture refused without evidence' || E'\n';
  end;

  insert into public.seo_measurements (company_entity_id, task_id, source, metric, value,
    window_kind, period_start, period_end)
  values (co, task, 'shopify_landing_pages', 'sessions', 100, 'baseline', '2026-08-01','2026-08-28');
  out := out || 'PASS — baseline accepted before publication exists' || E'\n';

  insert into public.seo_task_publications (company_entity_id, task_id, published_at, method, note)
  values (co, task, '2026-09-01T00:00:00Z', 'manual_confirmation', 'test');
  select is_published into ok from public.seo_tasks_v where id=task;
  out := out || case when ok then 'PASS' else 'FAIL' end
      || ' — publication row makes it published' || E'\n';

  -- INVARIANT 2. Checked on the reporting PERIOD, not on captured_at: a window
  -- that reaches past the change is a follow-up mislabelled, and it would make
  -- any before/after comparison meaningless.
  begin
    insert into public.seo_measurements (company_entity_id, task_id, source, metric, value,
      window_kind, period_start, period_end)
    values (co, task, 'shopify_landing_pages', 'sessions', 120, 'baseline', '2026-08-20','2026-09-15');
    out := out || 'FAIL — baseline overlapping publication was accepted' || E'\n';
  exception when check_violation then
    out := out || 'PASS — baseline reaching past publication refused' || E'\n';
  end;

  insert into public.seo_measurements (company_entity_id, task_id, source, metric, value,
    window_kind, period_start, period_end)
  values (co, task, 'shopify_landing_pages', 'sessions', 120, 'follow_up', '2026-09-02','2026-09-29');
  out := out || 'PASS — follow_up over a post-publication window accepted' || E'\n';

  -- A measurement of nothing in particular cannot be compared to anything.
  begin
    insert into public.seo_measurements (company_entity_id, source, metric, value,
      window_kind, period_start, period_end)
    values (co, 'manual', 'sessions', 1, 'baseline', '2026-08-01','2026-08-02');
    out := out || 'FAIL — measurement with no project or task accepted' || E'\n';
  exception when check_violation then
    out := out || 'PASS — measurement must belong to a project or task' || E'\n';
  end;

  -- Not a failure: this is the rollback, and the message is the report.
  raise exception '%', out;
end;
$test$;
