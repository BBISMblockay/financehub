-- v3 dashboards, pass 4: the matrix visual.
--
-- Every visual so far reduces a result to one dimension and one measure:
-- a bar has categories along an axis, a line has time. A financial
-- statement is not that shape. A P&L is LINES down and MONTHS across, and
-- rendering it as a long table -- one row per line per month, 160 rows --
-- is correct data that nobody can read as a statement.
--
-- The same shape covers far more than finance: sales by category by month,
-- units by size by location, spend by platform by week. Any "X by Y"
-- question wants a matrix, and until now the answer was a 500-row table.
--
-- Adding it means widening the visual_type CHECK, which is the only reason
-- this needs a migration at all -- everything else about a visual lives in
-- the schemaless visual_config, deliberately, so that adding a chart option
-- never needs one.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_visual_type_check;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_visual_type_check
  check (visual_type in ('table', 'kpi', 'bar', 'line', 'donut', 'matrix'));

comment on column public.dashboard_widgets.visual_type is
  'Which visual draws this widget: table, kpi, bar, line, donut, or matrix. A matrix reads row_field (down) x x_field (across) with y_field as the cell measure; every other visual ignores row_field.';
