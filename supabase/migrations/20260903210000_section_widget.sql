-- v3 dashboards, pass 5: a section header tile.
--
-- A board of fourteen tiles is a wall. Grouping them -- "Sales", "Paid
-- media", "Inventory" -- is the difference between a page you scan and a
-- page you scroll past, and it is the last obviously-missing thing before
-- a dashboard reads as a product rather than a query dump.
--
-- A section is a WIDGET with no report: it occupies grid space, it drags
-- and resizes like everything else, and it needs no new table, no new
-- renderer path in the page, and no special case in the save buffer.
-- report_id is already nullable (it is `on delete set null` so that
-- deleting a report never deletes someone's tile), so a null there is
-- already a shape the runtime handles.
--
-- The only thing in the way was the visual_type CHECK -- the same one
-- widened for `matrix`. That remains the ONLY part of a visual needing a
-- migration; everything else lives in the schemaless visual_config.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_visual_type_check;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_visual_type_check
  check (visual_type in ('table', 'kpi', 'bar', 'line', 'donut', 'matrix', 'section'));

-- A section carries no report, so the widget's own title IS its content.
-- Guard it here rather than trusting the UI: a section with no title is an
-- invisible tile that still takes up grid space, which is baffling to drag
-- around and impossible to click.
alter table public.dashboard_widgets
  drop constraint if exists dashboard_widgets_section_has_title;

alter table public.dashboard_widgets
  add constraint dashboard_widgets_section_has_title
  check (visual_type <> 'section' or coalesce(btrim(title), '') <> '');

comment on column public.dashboard_widgets.visual_type is
  'Which visual draws this widget: table, kpi, bar, line, donut, matrix, or section. A matrix reads row_field (down) x x_field (across) with y_field as the cell measure. A section is a heading with no report_id -- its title is its content.';
