-- SILO dashboards: one global board every company sees with its own data.
--
-- Until now a new tenant finished onboarding, opened Dashboards and found it
-- empty: every seeded board belongs to Baseballism, and the SILO reports sit
-- on nobody's canvas. This does for dashboards what `source = 'system'` did
-- for saved reports (20260828150000): a board SILO defines ONCE, with
-- `company_entity_id IS NULL`, shown to every company and "created by SILO".
--
-- Why that is safe, and why one board serves every tenant: a widget stores
-- CONFIGURATION, never data, and every tile runs its report's SQL through
-- chat_run_readonly_query under the VIEWER'S RLS, so the same widget rows
-- show each company its own sales and nobody else's. Every
-- report on the board is itself a global system report, so the board never
-- names one tenant's report on another tenant's screen.
--
-- A global board is read-only to EVERY client, exec/owner included -- same
-- stance as a system report. Customising it means saving a copy, which is an
-- ordinary company board (see /v3/dashboard.html's "Save a copy"). Four locks,
-- each covered by a test in silo-dashboards-database.test.mjs:
--   1. dashboards_source_matches_scope: a system board has no company and a
--      user board always has one, so neither can be forged into the other.
--   2. The dashboards insert/update/delete policies already require
--      company_entity_id = active_company_id(), which a NULL never satisfies.
--   3. The WIDGET write policies required only that the caller own the parent
--      board OR be exec/owner -- and a global board has no owner, so an
--      exec/owner could have edited SILO's board for every tenant. They now
--      also require the parent to belong to the caller's active company.
--   4. The widget INSERT policy additionally pins the widget to its parent's
--      company, so no widget can be hung on another scope's board.
-- The select policy is character-for-character the saved-report one's shape:
-- your company's shared boards, your own private ones, and global system ones.

-- ── 1. Which boards are SILO's ─────────────────────────────────────────────
alter table public.dashboards
  add column if not exists source text not null default 'user';

alter table public.dashboards drop constraint if exists dashboards_source_check;
alter table public.dashboards
  add constraint dashboards_source_check check (source in ('user', 'system'));

alter table public.dashboards drop constraint if exists dashboards_source_matches_scope;
alter table public.dashboards
  add constraint dashboards_source_matches_scope
  check ((source = 'system') = (company_entity_id is null));

comment on column public.dashboards.source is
  '''system'' = a SILO dashboard: global (company_entity_id IS NULL), shown to every company, read-only to every client, written only by migrations. ''user'' = a company''s own board. See 20260925120000.';

-- ── 2. RLS ─────────────────────────────────────────────────────────────────
alter policy dashboards_select on public.dashboards
  using (
    (company_entity_id = public.active_company_id()
      and (visibility = 'company' or created_by = auth.uid()))
    or (company_entity_id is null and source = 'system')
  );

alter policy dashboard_widgets_insert on public.dashboard_widgets
  with check (
    company_entity_id = public.active_company_id()
    and exists (select 1 from public.dashboards d
                 where d.id = dashboard_widgets.dashboard_id
                   and d.company_entity_id = public.active_company_id()
                   and (d.created_by = auth.uid() or public.is_exec_or_owner()))
  );

alter policy dashboard_widgets_update on public.dashboard_widgets
  using (
    exists (select 1 from public.dashboards d
             where d.id = dashboard_widgets.dashboard_id
               and d.company_entity_id = public.active_company_id()
               and (d.created_by = auth.uid() or public.is_exec_or_owner()))
  )
  with check (
    exists (select 1 from public.dashboards d
             where d.id = dashboard_widgets.dashboard_id
               and d.company_entity_id = public.active_company_id()
               and (d.created_by = auth.uid() or public.is_exec_or_owner()))
  );

alter policy dashboard_widgets_delete on public.dashboard_widgets
  using (
    exists (select 1 from public.dashboards d
             where d.id = dashboard_widgets.dashboard_id
               and d.company_entity_id = public.active_company_id()
               and (d.created_by = auth.uid() or public.is_exec_or_owner()))
  );

-- ── 3. The view names SILO as the author ───────────────────────────────────
-- New columns go at the END: create or replace view cannot reorder them.
create or replace view public.dashboards_v
with (security_invoker = true) as
select d.id,
       d.company_entity_id,
       d.created_by,
       case when d.source = 'system' then 'SILO' else p.name end as created_by_name,
       d.name,
       d.description,
       d.visibility,
       d.filter_state,
       d.created_at,
       d.updated_at,
       (select count(*) from public.dashboard_widgets w where w.dashboard_id = d.id) as widget_count,
       d.source
  from public.dashboards d
  left join public.profiles p on p.id = d.created_by;

-- ── 4. The SILO Overview board ─────────────────────────────────────────────
-- Fixed ids and an upsert, like the system report seeds: the definition is
-- migration-owned and a re-run lands the same board. Sales first, and only
-- what a Shopify-only tenant has on day one -- marketing tiles are left off,
-- since without an ad platform connected every one of them renders empty,
-- which reads as broken in a demo. Dates are TOKENS, never resolved dates,
-- so the board keeps meaning "the last 28 completed days".
insert into public.dashboards
  (id, company_entity_id, created_by, name, description, visibility, filter_state, source)
values ('5110da5b-0000-4000-a000-000000000001', null, null,
        'Overview',
        'Sales, stock and open purchase orders at a glance, for every company. Maintained by SILO; save a copy to change it.',
        'company',
        '{"date_from": "today-28d", "date_to": "today-1d", "as_of": "today-1d", "cover_weeks": 26}'::jsonb,
        'system')
on conflict (id) do update set
  company_entity_id = null, created_by = null,
  name = excluded.name, description = excluded.description,
  visibility = excluded.visibility, filter_state = excluded.filter_state,
  source = excluded.source;

insert into public.dashboard_widgets
  (id, dashboard_id, company_entity_id, created_by, report_id, query_index,
   title, visual_type, visual_config, layout, sort_order)
values
('5110da5b-0000-4000-a001-000000000001','5110da5b-0000-4000-a000-000000000001',null,null,
 null,0,'Sales','section',
 '{"note": "Completed days only. Change the dates above to move every sales tile at once."}'::jsonb,
 '{"x": 0, "y": 0, "w": 12, "h": 1}'::jsonb,0),
('5110da5b-0000-4000-a001-000000000002','5110da5b-0000-4000-a000-000000000001',null,null,
 'c3000000-0000-4000-a000-000000000001',0,'Sales vs last year','table',
 '{"columns": ["period", "net_sales", "net_sales_ly", "vs_last_year", "orders", "aov"]}'::jsonb,
 '{"x": 0, "y": 1, "w": 12, "h": 3}'::jsonb,1),
('5110da5b-0000-4000-a001-000000000003','5110da5b-0000-4000-a000-000000000001',null,null,
 '5110de50-0000-4000-a000-000000000001',0,'Net sales by day','line',
 '{"x_field": "day_date", "y_field": "net_sales", "sort": "x_asc", "limit": 0}'::jsonb,
 '{"x": 0, "y": 4, "w": 8, "h": 4}'::jsonb,2),
('5110da5b-0000-4000-a001-000000000004','5110da5b-0000-4000-a000-000000000001',null,null,
 'c3000000-0000-4000-a000-000000000003',0,'Merchandise revenue by channel','donut',
 '{"x_field": "channel", "y_field": "merch_revenue", "sort": "desc", "limit": 8}'::jsonb,
 '{"x": 8, "y": 4, "w": 4, "h": 4}'::jsonb,3),
('5110da5b-0000-4000-a001-000000000005','5110da5b-0000-4000-a000-000000000001',null,null,
 '5110de50-0000-4000-a000-000000000002',0,'Top products by units','table',
 '{"limit": 10, "columns": ["product_title", "units_sold", "net_sales"]}'::jsonb,
 '{"x": 0, "y": 8, "w": 7, "h": 5}'::jsonb,4),
('5110da5b-0000-4000-a001-000000000006','5110da5b-0000-4000-a000-000000000001',null,null,
 '5110de50-0000-4000-a000-000000000003',0,'Net sales by location','bar',
 '{"x_field": "location_tag", "y_field": "net_sales", "sort": "desc", "limit": 10}'::jsonb,
 '{"x": 7, "y": 8, "w": 5, "h": 5}'::jsonb,5),
('5110da5b-0000-4000-a001-000000000007','5110da5b-0000-4000-a000-000000000001',null,null,
 null,0,'Inventory and purchasing','section',
 '{"note": "Current state, not a period."}'::jsonb,
 '{"x": 0, "y": 13, "w": 12, "h": 1}'::jsonb,6),
('5110da5b-0000-4000-a001-000000000008','5110da5b-0000-4000-a000-000000000001',null,null,
 'c1000000-0000-4000-a000-000000000001',0,'Units on hand','kpi',
 '{"y_field": "units_on_hand", "abbreviate": true}'::jsonb,
 '{"x": 0, "y": 14, "w": 4, "h": 2}'::jsonb,7),
('5110da5b-0000-4000-a001-000000000009','5110da5b-0000-4000-a000-000000000001',null,null,
 'c1000000-0000-4000-a000-000000000001',0,'Units on order','kpi',
 '{"y_field": "units_on_order", "abbreviate": true}'::jsonb,
 '{"x": 4, "y": 14, "w": 4, "h": 2}'::jsonb,8),
('5110da5b-0000-4000-a001-00000000000a','5110da5b-0000-4000-a000-000000000001',null,null,
 'c1000000-0000-4000-a000-000000000001',0,'Weeks of cover (incl. incoming)','kpi',
 '{"y_field": "weeks_of_cover"}'::jsonb,
 '{"x": 8, "y": 14, "w": 4, "h": 2}'::jsonb,9),
('5110da5b-0000-4000-a001-00000000000b','5110da5b-0000-4000-a000-000000000001',null,null,
 'c1000000-0000-4000-a000-000000000006',0,'Running low','table',
 '{"limit": 8, "columns": ["product_type", "units_on_hand", "units_on_order", "weeks_on_hand"]}'::jsonb,
 '{"x": 0, "y": 16, "w": 6, "h": 4}'::jsonb,10),
('5110da5b-0000-4000-a001-00000000000c','5110da5b-0000-4000-a000-000000000001',null,null,
 '5110de50-0000-4000-a000-000000000004',0,'Open purchase orders','table',
 '{"limit": 8, "columns": ["po_name", "factory_name", "status", "expected_arrival_date", "total_units"]}'::jsonb,
 '{"x": 6, "y": 16, "w": 6, "h": 4}'::jsonb,11)
on conflict (id) do update set
  dashboard_id = excluded.dashboard_id, company_entity_id = null, created_by = null,
  report_id = excluded.report_id, query_index = excluded.query_index,
  title = excluded.title, visual_type = excluded.visual_type,
  visual_config = excluded.visual_config, layout = excluded.layout,
  sort_order = excluded.sort_order;

-- A re-run after a tile is dropped from the list above must drop it here too.
delete from public.dashboard_widgets
 where dashboard_id = '5110da5b-0000-4000-a000-000000000001'
   and id not in (
     '5110da5b-0000-4000-a001-000000000001','5110da5b-0000-4000-a001-000000000002',
     '5110da5b-0000-4000-a001-000000000003','5110da5b-0000-4000-a001-000000000004',
     '5110da5b-0000-4000-a001-000000000005','5110da5b-0000-4000-a001-000000000006',
     '5110da5b-0000-4000-a001-000000000007','5110da5b-0000-4000-a001-000000000008',
     '5110da5b-0000-4000-a001-000000000009','5110da5b-0000-4000-a001-00000000000a',
     '5110da5b-0000-4000-a001-00000000000b','5110da5b-0000-4000-a001-00000000000c');
