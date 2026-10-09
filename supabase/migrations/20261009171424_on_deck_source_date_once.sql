-- Preserve the fingerprint and 90-day inclusive cutoff; resolve company date once.
create or replace function public.on_deck_source_version(p_company uuid,p_kind text) returns text
language plpgsql stable security definer set search_path='' as $$
declare v text; company_today date:=(now() at time zone public.silo_company_timezone(p_company))::date; begin
 if p_kind='restock' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.products_master where company_entity_id=p_company),
 (select concat(count(*),':',max(last_seen_at)) from public.shopify_product_skus where company_entity_id=p_company),
 (select max(finished_at)::text from public.sync_jobs where company_entity_id=p_company and status='success' and job_type in ('inventory_snapshot','incremental_sales','history_import')),
 (select concat(count(*),':',max(updated_at)) from public.po_headers where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.po_lines where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.sales_by_day where company_entity_id=p_company and day_date>=company_today-90),
 (select concat(count(*),':',max(snapshot_at),':',sum(total_available_quantity)) from public.inventory_on_hand_current_mv where company_entity_id=p_company)) into v;
 elsif p_kind='launch' then
 select concat_ws('|',(select concat(count(*),':',max(updated_at)) from public.launch_calendar where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_product_readiness where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.launch_tasks where company_entity_id=p_company and not is_private)) into v;
 elsif p_kind='seo' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.search_console_page_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company),
 (select concat(count(*),':',max(updated_at)) from public.seo_tasks where company_entity_id=p_company)) into v;
 elsif p_kind='ads' then
 select concat_ws('|',(select concat(count(*),':',max(synced_at)) from public.meta_ad_performance_daily where company_entity_id=p_company),
 (select concat(count(*),':',max(synced_at)) from public.meta_ad_creatives where company_entity_id=p_company),
 (select concat(count(*),':',max(fetched_at)) from public.page_inspections where company_entity_id=p_company)) into v;
 else raise exception 'Unknown workflow'; end if;
 return md5(p_kind||':'||company_today::text||':'||coalesce(v,'')||':'||coalesce((select updated_at::text from public.on_deck_settings where company_entity_id=p_company),''));
end $$;

-- CREATE OR REPLACE preserves the existing RPC grants. No timeout changes.
