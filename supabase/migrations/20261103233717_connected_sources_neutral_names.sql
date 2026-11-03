-- 20261103233717 -- A connected AI talks about "SILO's connected sources", never the
-- vendor that carries them.
--
-- Blake (2026-11-03): the SILO MCP should not name the data vendor; it is SILO
-- data. Bots read three things: the edge function's own text (fixed in code), the
-- chat catalog's descriptions, and relation names. This migration handles the last
-- two:
--   1. connected_source_metrics_daily_v -- a neutral, security_invoker view over the
--      vendor-named table, so RLS is still the boundary through it.
--   2. The vendor-named tables are hidden from the catalog (which is also the MCP
--      query allowlist), and the remaining descriptions are rewritten without the
--      vendor's name.
-- Idempotent: create or replace, and catalog updates that set known values.

begin;

create or replace view public.connected_source_metrics_daily_v
with (security_invoker = true) as
select m.company_entity_id,
       m.ds_id as data_source,
       m.account_id,
       m.account_name,
       m.day_date,
       m.object_type,
       m.object_id,
       m.object_name,
       m.impressions,
       m.clicks,
       m.spend,
       m.conversions,
       m.revenue,
       m.sends,
       m.delivered,
       m.opens,
       m.sessions,
       m.users,
       m.orders,
       m.metrics,
       m.synced_at
  from public.windsor_metrics_daily m;

comment on view public.connected_source_metrics_daily_v is
  'Daily numbers from connected data sources that have no table of their own, under neutral names. security_invoker: RLS on the base table is the boundary. 20261103233717.';

grant select on public.connected_source_metrics_daily_v to authenticated;

commit;

begin;

-- The catalog is generated from pg_class, so the new view has no row until a
-- refresh. Refresh, then fail loudly if it is still absent.
select public.refresh_chat_schema_catalog();

do $$
begin
  if not exists (select 1 from public.silo_chat_schema_catalog
                  where relname = 'connected_source_metrics_daily_v') then
    raise exception 'connected_source_metrics_daily_v has no catalog row after a refresh';
  end if;
end $$;

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['connected source','email','reviews','analytics','metrics','connector','pinterest','klaviyo'],
  description = $d$Daily numbers from connected data sources that have no table of their own (email, reviews, analytics and similar). One row per data_source x account x object x day. object_type 'account' is the account's daily total; 'campaign' rows are parts of it, so never add the two together. The typed columns (impressions, clicks, spend, conversions, revenue, sends, delivered, opens, sessions, users, orders) are filled only when the source has a field meaning that; NULL means not reported, never zero. metrics holds every numeric field the source returned, by the source's field id. revenue and conversions are what the source CLAIMS: they overlap net sales and each other, so never add them to either. Ad platforms such as TikTok are in marketing_kpis_daily, not here. For the newest days or a field not stored here, use the live connection tools.$d$,
  updated_at = now()
where relname = 'connected_source_metrics_daily_v';

-- Hidden: the view above replaces the metrics table for readers; the mapping,
-- link and account tables are plumbing.
update public.silo_chat_schema_catalog set is_hidden = true, updated_at = now()
where relname in ('windsor_metrics_daily', 'windsor_field_mappings', 'windsor_links', 'windsor_linked_accounts');

update public.silo_chat_schema_catalog set
  keywords = array['klaviyo','email','sms','campaign','flow','opens','clicks','email revenue','connected source'],
  description = $d$Klaviyo email and SMS performance, pulled nightly from the company's connected Klaviyo account. One row per account x report x object x day. report = 'account' (the account's daily totals: object_id is empty), 'campaign' (object = campaign) or 'flow' (object = flow message, parent = flow). NEVER add the three reports together: campaign and flow rows are parts of the account total. revenue is what Klaviyo ATTRIBUTES to email/SMS: it overlaps net sales and ad-platform revenue, so never add it to either. NULL means not reported, not zero. metrics and attributes hold every other field the source returned, by field id.$d$,
  updated_at = now()
where relname = 'klaviyo_performance_daily';

commit;
