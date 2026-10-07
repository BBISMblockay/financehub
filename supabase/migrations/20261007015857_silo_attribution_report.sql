create or replace view public.silo_attribution_campaigns_v with(security_invoker=true) as
 select distinct on(company_entity_id,platform,campaign_id) company_entity_id,platform,campaign_id,campaign_name
 from public.marketing_kpis_daily where campaign_id is not null and nullif(trim(campaign_name),'') is not null
 order by company_entity_id,platform,campaign_id,day_date desc nulls last,synced_at desc nulls last,campaign_name;
revoke all on public.silo_attribution_campaigns_v from anon;
grant select on public.silo_attribution_campaigns_v to authenticated,service_role;

-- Revenue always has a row, even if the model has not yet been backfilled.
create or replace view public.silo_attribution_ledger_v with(security_invoker=true) as
 select d.company_entity_id,d.connection_id,d.day,d.currency,d.shop_timezone,d.extracted_at,
 l->>'order_id' as order_id,(l->>'net_cents')::bigint as net_cents,(l->>'total_cents')::bigint as total_cents,
 w.days as window_days,o.evidence->'order'->>'name' as order_name,
 coalesce(o.evidence->'allocations'->w.days::text->>'channel','Unattributed') as channel,
 o.evidence->'allocations'->w.days::text as allocation,
 o.fetched_at as evidence_fetched_at
 from public.shopify_attribution_days d
 cross join lateral jsonb_array_elements(d.ledger) l
 cross join (values(7),(14),(30),(60)) w(days)
 left join public.shopify_attribution_orders o on o.connection_id=d.connection_id
 and o.company_entity_id=d.company_entity_id and o.order_id=l->>'order_id';
revoke all on public.silo_attribution_ledger_v from anon;
grant select on public.silo_attribution_ledger_v to authenticated,service_role;
