-- Early-access contact intake: platform-only queue, service-only writer/quotas.
-- Begin onboarding interest checks.
with objects as (
  select to_regclass('public.onboarding_interest_queue') as queue,
    to_regclass('public.onboarding_interest_rate_buckets') as buckets,
    to_regprocedure('public.submit_onboarding_interest(text,text,text)') as writer
)
select 'Early-access intake structure' as check_name,
 case when queue is null or buckets is null or writer is null then 'MISSING: onboarding_interest_queue migration'
 when exists(select 1 from pg_class where oid in (queue,buckets) and not relrowsecurity)
   then 'CRITICAL: intake RLS disabled'
 when (select count(*) from pg_constraint where conrelid=queue and conname in
   ('onboarding_interest_name_valid','onboarding_interest_company_valid','onboarding_interest_email_valid',
    'onboarding_interest_source_valid','onboarding_interest_status_valid')) <> 5
   then 'CRITICAL: intake validation constraints missing'
 when not exists(select 1 from pg_constraint c where c.conrelid=queue and c.contype='u'
   and c.conkey=array[(select attnum from pg_attribute where attrelid=queue and attname='email')])
   then 'CRITICAL: intake email uniqueness missing'
 when (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='submit_onboarding_interest')<>1
   then 'CRITICAL: unexpected intake writer overload'
 when not exists(select 1 from pg_constraint where conrelid=buckets and conname='onboarding_interest_bucket_key_valid'
   and pg_get_constraintdef(oid) = 'CHECK ((bucket_key = ANY (ARRAY[''global:minute''::text, ''global:day''::text])))')
   then 'CRITICAL: intake two-key quota bound missing or changed'
 when exists(select 1 from pg_proc where oid=writer and prosrc ~* '\m(drop|delete|truncate)\M')
   then 'CRITICAL: intake writer contains a removal operation'
 when (select prosecdef from pg_proc where oid=writer)
   then 'CRITICAL: intake writer must remain SECURITY INVOKER'
 when not exists(select 1 from pg_proc where oid=writer and prosrc like '%pg_advisory_xact_lock%'
   and prosrc like '%on conflict (bucket_key) do update%' and prosrc like '%on conflict (email) do nothing%')
   then 'CRITICAL: intake atomic/bounded/preserve-on-duplicate contract changed'
 else 'ok' end as status from objects;

with objects as (
  select to_regclass('public.onboarding_interest_queue') as queue,
    to_regclass('public.onboarding_interest_rate_buckets') as buckets,
    to_regprocedure('public.submit_onboarding_interest(text,text,text)') as writer
)
select 'Early-access intake permissions' as check_name,
 case when queue is null or buckets is null or writer is null then 'MISSING: onboarding_interest_queue migration'
 when has_table_privilege('anon',queue,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_any_column_privilege('anon',queue,'SELECT,INSERT,UPDATE,REFERENCES')
   then 'CRITICAL: anonymous intake queue access'
 when has_table_privilege('authenticated',queue,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_any_column_privilege('authenticated',queue,'INSERT,REFERENCES')
   or exists(select 1 from pg_attribute where attrelid=queue and attnum>0 and not attisdropped and attname<>'status'
      and has_column_privilege('authenticated',queue,attnum,'UPDATE'))
   then 'CRITICAL: intake client writes exceed status-only updates'
 when not has_table_privilege('authenticated',queue,'SELECT')
   or not has_column_privilege('authenticated',queue,'status','UPDATE')
   then 'MISSING: platform queue read/status privileges'
 when exists(select 1 from unnest(array['anon','authenticated']) as roles(role)
    where has_table_privilege(role,buckets,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(role,buckets,'SELECT,INSERT,UPDATE,REFERENCES')
       or has_function_privilege(role,writer,'EXECUTE'))
   then 'CRITICAL: intake quota or writer exposed to clients'
 when has_table_privilege('service_role',queue,'DELETE,TRUNCATE')
   or has_table_privilege('service_role',buckets,'DELETE,TRUNCATE')
   then 'CRITICAL: service intake grants permit removal'
 when not has_function_privilege('service_role',writer,'EXECUTE')
   or not has_table_privilege('service_role',queue,'SELECT')
   or not has_table_privilege('service_role',queue,'INSERT')
   then 'MISSING: service intake persistence privileges'
 when (select count(*) from pg_policy where polrelid=queue)<>2
   or exists(select 1 from pg_policy where polrelid=buckets)
   then 'CRITICAL: unexpected intake policy set'
 when not exists(select 1 from pg_policy where polrelid=queue and polcmd='r'
   and polroles=array[(select oid from pg_roles where rolname='authenticated')]
   and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g')='SELECTis_platform_adminASis_platform_admin')
   or not exists(select 1 from pg_policy where polrelid=queue and polcmd='w'
     and polroles=array[(select oid from pg_roles where rolname='authenticated')]
     and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g')='SELECTis_platform_adminASis_platform_admin'
     and regexp_replace(pg_get_expr(polwithcheck,polrelid),'[[:space:]()]','','g')='SELECTis_platform_adminASis_platform_admin')
   then 'CRITICAL: intake policies are not exclusively platform-admin scoped'
 else 'ok' end as status from objects;
-- End onboarding interest checks.
