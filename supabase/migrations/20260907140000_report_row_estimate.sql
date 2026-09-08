-- How big is this report, actually?
--
-- chat_run_readonly_query returns at most 1000 rows per page. Every SURFACE
-- that renders a report is already honest about that -- a table tile offers
-- "Load next 1000 rows" and says how many are loaded, a chart tile that hits
-- the cap says so and tells you to aggregate in the report, and the builder's
-- own preview pages the same way.
--
-- What none of them do is tell the AUTHOR, at the moment they are authoring.
-- The size of a report is only discoverable after it is already a tile on
-- somebody's dashboard, which is one step too late: by then it is in the
-- picker and other people's boards point at it.
--
-- Measured on prod 2026-09-07, two tiles were already over the cap and
-- nobody could have known without wrapping each query in a count() by hand:
--
--   Inventory exposure -- stock and incoming by SKU   7,231 rows, showing 1,000
--   Logistics · Top products by units sold            2,049 rows, showing 1,000
--
-- The first was authored that day. That is the pattern worth catching early:
-- ask for "inventory cash exposure" and SKU grain is the natural way to write
-- it, and SKU grain here is 7,231 rows and climbing.
--
-- This is deliberately a RECORD, not a RULE. Nothing refuses to save a large
-- report: an export-shaped report is a legitimate thing to build, and a
-- builder that blocks it just sends the author to a duplicate, which is the
-- behaviour the saved-report editor exists to stop. The column exists so the
-- size is visible before the decision, and so "which reports are over the
-- cap" is a query rather than an afternoon.
--
-- NOT a bigger cap, on purpose. A tile wanting 7,231 SKU-grain rows is asking
-- a question a dashboard cannot answer; raising the cap would hide that
-- signal rather than act on it.
--
-- row_estimate is the row count of the report's FIRST query as measured on
-- the last preview that ran to a count, and row_estimate_at says when. Both
-- nullable and both meaningless without the other: a report saved before this
-- migration, or one whose count timed out, has null and must render as
-- "unknown" rather than as zero. Data volume moves, so this is a reading with
-- a date on it, never a fact about the report.

alter table public.silo_chat_saved_reports
  add column if not exists row_estimate    bigint,
  add column if not exists row_estimate_at timestamptz;

comment on column public.silo_chat_saved_reports.row_estimate is
  'Row count of this report''s first query, as measured by the report builder on the last preview that ran a count. NULL means never measured (saved before 20260907140000, or the count timed out) -- render that as unknown, never as zero. Compare against chat_run_readonly_query''s 1000-row page cap to know whether a dashboard tile shows the whole result. A reading with a date (row_estimate_at), not a property of the report: the underlying data moves.';

comment on column public.silo_chat_saved_reports.row_estimate_at is
  'When row_estimate was measured. Without it the count is not interpretable -- a 400-row reading from six months ago says nothing about today.';

-- No policy change. The insert policy still requires company_entity_id and
-- pins source to ask_silo/manual, and the update policy's WITH CHECK is
-- unchanged -- these are two ordinary columns inside a payload those policies
-- already govern. A `system` row stays unwritable by any client, so a global
-- definition cannot acquire an estimate from a browser; it keeps null until a
-- migration sets one, which is the correct answer for a definition whose row
-- count differs per tenant anyway.


-- Expose the two columns through the view the picker actually reads.
--
-- silo_chat_saved_reports_v carries an EXPLICIT column list, so a new column
-- on the base table is invisible through it until named here -- which is why
-- builder_config is absent too and the report builder reads the base table
-- for it.
--
-- Appended at the END of the select list, never inserted mid-list: several
-- callers select columns by name but the view's column ORDER is still part of
-- its contract, and reordering it is the same class of silent breakage as
-- jsonb_agg reordering a result's keys. security_invoker = true is preserved
-- explicitly -- recreating the view without it would drop RLS propagation and
-- hand every company's saved reports to every user.
create or replace view public.silo_chat_saved_reports_v
  with (security_invoker = true) as
 SELECT r.id,
    r.company_entity_id,
    r.created_by,
    p.name AS created_by_name,
    r.source,
    r.title,
    r.description,
    r.question,
    r.answer,
    r.queries_run,
    r.visibility,
    r.columns_metadata,
    r.parameters,
    r.created_at,
    r.updated_at,
    r.row_estimate,
    r.row_estimate_at
   FROM silo_chat_saved_reports r
     LEFT JOIN profiles p ON p.id = r.created_by;

grant select on public.silo_chat_saved_reports_v to authenticated;
revoke all on public.silo_chat_saved_reports_v from anon;
