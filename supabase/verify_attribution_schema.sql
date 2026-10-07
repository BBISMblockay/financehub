-- Run alongside verify_v2_schema.sql after applying attribution migrations.
select c.relname,
 case when c.relrowsecurity
 and not has_table_privilege('anon',c.oid,'SELECT')
 and has_table_privilege('authenticated',c.oid,'SELECT')
 and not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE')
 then 'ok' else 'CRITICAL' end as status
from pg_class c where c.oid in ('public.shopify_attribution_orders'::regclass,'public.shopify_attribution_days'::regclass);
select 'publish_shopify_attribution_day' as routine,
 case when not has_function_privilege('anon','public.publish_shopify_attribution_day(uuid,date,text,text,jsonb,jsonb,bigint,bigint,timestamptz)','EXECUTE')
 and not has_function_privilege('authenticated','public.publish_shopify_attribution_day(uuid,date,text,text,jsonb,jsonb,bigint,bigint,timestamptz)','EXECUTE')
 and has_function_privilege('service_role','public.publish_shopify_attribution_day(uuid,date,text,text,jsonb,jsonb,bigint,bigint,timestamptz)','EXECUTE')
 then 'ok' else 'CRITICAL' end as status;

