-- v3 dashboards, pass 6: an Answer widget -- render a saved Ask SILO
-- synthesis as prose, not as a forced table.
--
-- The gap this closes: `queries_run` is a TRANSCRIPT (see
-- `silo_chat_saved_reports.parameters`'s comment and v3/README.md's
-- "Which query of a saved answer to draw"), and for a genuinely open-ended
-- question -- "tell me about the business and suggest action items" -- no
-- single query in that transcript IS the answer. The real answer is the
-- written synthesis in `silo_chat_saved_reports.answer`, which today has no
-- widget that can show it: every existing visual draws ROWS from ONE query.
-- Found live 2026-09-04 on the Ownership dashboard -- a 25-query answer
-- (sales trend, marketing, returns, launches, inventory, POs) got added as a
-- table pointed at the transcript's LAST query, which happened to be a
-- narrow PO lookup that legitimately returns 0 rows (confirming the
-- written answer's own finding: "no PO in the pipeline for this SKU") --
-- correct data, useless tile, because the real content was five paragraphs
-- of prose the table format cannot carry.
--
-- An Answer widget is a WIDGET WITH a report but NO query: it renders
-- `report.answer` as sanitized markdown, the same rendering Ask SILO's own
-- chat bubbles and its saved-reports detail view already use (marked +
-- DOMPurify). Same shape as `section` (20260903210000) in reverse -- section
-- is a widget with NO report and a title as its content; answer is a widget
-- WITH a report and the report's answer as its content. Needs no new table:
-- `silo_chat_saved_reports.answer` already holds exactly this text.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_visual_type_check;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_visual_type_check
  check (visual_type in ('table', 'kpi', 'bar', 'line', 'donut', 'matrix', 'section', 'answer'));

-- The inverse of dashboard_widgets_section_has_title: an answer widget with
-- no report has nothing to render -- an empty tile that looks broken rather
-- than an intentional heading the way an untitled section would.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_answer_has_report;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_answer_has_report
  check (visual_type <> 'answer' or report_id is not null);

comment on column public.dashboard_widgets.visual_type is
  'Which visual draws this widget: table, kpi, bar, line, donut, matrix, section, or answer. A matrix reads row_field (down) x x_field (across) with y_field as the cell measure. A section is a heading with no report_id -- its title is its content. An answer is the inverse: it REQUIRES report_id and renders that report''s saved answer text as markdown -- no query_index, no rows, for an Ask SILO analysis that never reduced to one dataset.';

-- report_answer travels alongside query_sql for the same reason: an answer
-- widget needs the text at render time without a second round trip, and
-- security_invoker means a report the viewer cannot see yields null here
-- exactly like query_sql already does -- no new privacy surface.
drop view if exists public.dashboard_widgets_v;
create view public.dashboard_widgets_v
with (security_invoker = true) as
select
  w.id,
  w.dashboard_id,
  w.company_entity_id,
  w.created_by,
  w.report_id,
  w.query_index,
  w.title,
  w.visual_type,
  w.visual_config,
  w.layout,
  w.sort_order,
  w.created_at,
  w.updated_at,
  r.title       as report_title,
  r.question    as report_question,
  r.description as report_description,
  r.source      as report_source,
  r.visibility  as report_visibility,
  r.columns_metadata as report_columns_metadata,
  r.parameters       as report_parameters,
  r.answer            as report_answer,
  r.queries_run[w.query_index + 1] as query_sql,
  coalesce(array_length(r.queries_run, 1), 0) as report_query_count
from public.dashboard_widgets w
left join public.silo_chat_saved_reports r on r.id = w.report_id;

revoke all on public.dashboard_widgets_v from anon;
grant select on public.dashboard_widgets_v to authenticated;
