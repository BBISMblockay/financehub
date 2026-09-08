-- v3 dashboards: three more visuals -- combo, heatmap, waterfall.
--
-- The CHECK on visual_type is the only part of a visual that ever needs a
-- migration; everything else about how a tile draws lives in the schemaless
-- `visual_config`, which is why stacked bars (`visual_config.stacked`) and
-- KPI sparklines (`visual_config.sparkline`) arrive in the same release
-- WITHOUT touching the database at all.
--
-- What each one is for, and why it is a type rather than a config flag:
--
--   combo      Bars and a line on one plot, on two axes. It is not "a bar
--              chart with an option": the second measure is drawn in a
--              different mark on a different scale, and offering that as a
--              checkbox on `bar` would let someone stack a ratio onto
--              dollars. A distinct type is where the field validation for
--              "which measure is the line" can live.
--   heatmap    Two dimensions and one measure, coloured rather than
--              positioned -- day-of-week x hour, size x location. Shares
--              the matrix's (row, column, cell) shape; differs in that the
--              cell is a colour, so its refusals differ too.
--   waterfall  A bridge: a starting value, signed contributions, a total.
--              Meaningless without an ORDER, which is why it reads the
--              query's own row order like the matrix does.
--
-- Additive and backward compatible: no existing row's visual_type changes,
-- and a widget saved before this migration is untouched. A page deployed
-- ahead of the migration simply cannot SAVE one of the three new types
-- (the CHECK rejects it with a clear constraint name); a database migrated
-- ahead of the page has three types nothing offers yet. Neither breaks
-- anything already on a board.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_visual_type_check;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_visual_type_check
  check (visual_type in (
    'table', 'kpi', 'bar', 'line', 'donut', 'matrix', 'section', 'answer',
    'combo', 'heatmap', 'waterfall'
  ));

comment on column public.dashboard_widgets.visual_type is
  'Which visual draws this widget: table, kpi, bar, line, donut, matrix, combo, heatmap, waterfall, section or answer. matrix/heatmap read row_field (down) x x_field (across) with y_field as the cell measure -- matrix prints it, heatmap colours it. combo plots visual_config.measures with line_measures drawn as lines on a second axis. waterfall reads the query''s own row order as the bridge order. A section is a heading with no report_id -- its title is its content. An answer REQUIRES report_id and renders that report''s saved answer text as markdown.';
