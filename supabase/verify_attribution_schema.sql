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

-- The ledger's discount-code columns (20261026180000). discount_codes must stay
-- jsonb: it distinguishes "no code used" (an empty array) from "collected before
-- codes were captured" (NULL), and a text[] cast would blur that.
select 'silo_attribution_ledger_v discount columns' as check_name,
 case when (select format_type(atttypid,atttypmod) from pg_attribute
            where attrelid='public.silo_attribution_ledger_v'::regclass and attname='discount_codes')='jsonb'
 and (select format_type(atttypid,atttypmod) from pg_attribute
      where attrelid='public.silo_attribution_ledger_v'::regclass and attname='discount_code')='text'
 then 'ok' else 'MISSING — apply 20261026180000_attribution_discount_codes.sql' end as status;

select 'attribution additive history' as check_name,
 case when to_regprocedure('public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb)') is null then 'MISSING'
 when has_function_privilege('anon','public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb)','EXECUTE')
   or has_function_privilege('authenticated','public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb)','EXECUTE') then 'CRITICAL'
 when not has_function_privilege('service_role','public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb)','EXECUTE') then 'MISSING'
 when not exists(select 1 from pg_trigger where tgrelid='public.shopify_attribution_orders'::regclass
   and tgname='protect_attribution_backfilled_codes' and tgenabled='O'
   and tgfoid=to_regprocedure('public.protect_attribution_backfilled_codes()')) then 'MISSING'
 else 'ok' end as status;
