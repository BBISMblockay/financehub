-- Apply separately after the attribution evidence migration. No data backfill.
-- Protect codes added by this path from an older concurrent normal publication.
create or replace function public.protect_attribution_backfilled_codes()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if old.evidence ? 'discount_codes_backfill' then
  if new.evidence#>'{order,discountCodes}' is not null
     and new.evidence#>'{order,discountCodes}' <> 'null'::jsonb
     and new.evidence#>'{order,discountCodes}' is distinct from old.evidence#>'{order,discountCodes}' then
   raise exception 'Backfilled discount code conflict';
  end if;
  if jsonb_typeof(new.evidence->'order') is distinct from 'object' then
   raise exception 'Backfilled order cannot be removed';
  end if;
  new.evidence := jsonb_set(new.evidence,'{order,discountCodes}',old.evidence#>'{order,discountCodes}')
    || jsonb_build_object('discount_codes_backfill',old.evidence->'discount_codes_backfill');
 end if;
 return new;
end $$;
revoke all on function public.protect_attribution_backfilled_codes() from public,anon,authenticated;
drop trigger if exists protect_attribution_backfilled_codes on public.shopify_attribution_orders;
create trigger protect_attribution_backfilled_codes before update on public.shopify_attribution_orders
 for each row execute function public.protect_attribution_backfilled_codes();

-- Append to the live job allowlist; never replace unrelated job types.
do $$ declare cur text; members text; begin
 select pg_get_constraintdef(oid) into cur from pg_constraint
 where conrelid='public.sync_jobs'::regclass and conname='sync_jobs_job_type_check';
 if cur is null then raise exception 'Missing sync_jobs job constraint'; end if;
 if cur like '%attribution_append%' then return; end if;
 members := substring(cur from 'ARRAY\[(.*?)\]');
 if members is null then raise exception 'Unexpected sync_jobs job constraint'; end if;
 alter table public.sync_jobs drop constraint sync_jobs_job_type_check;
 execute format('alter table public.sync_jobs add constraint sync_jobs_job_type_check check(job_type=any(array[%s,%L::text]))',members,'attribution_append');
end $$;

create or replace function public.append_shopify_attribution(
 p_company uuid,p_connection uuid,p_domain text,p_run uuid,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 c public.shopify_connections%rowtype; old_day public.shopify_attribution_days%rowtype;
 old_order public.shopify_attribution_orders%rowtype; receipt public.sync_jobs%rowtype;
 item jsonb; codes jsonb; incoming jsonb; stamp timestamptz; day_date date;
 n bigint; t bigint; fingerprint text; result jsonb; inserted integer:=0; filled integer:=0;
 kept integer:=0; unavailable integer:=0; day_added integer:=0; row_added boolean;
begin
 perform set_config('lock_timeout','5s',true);
 if p_company is null or p_connection is null or p_run is null or p_domain is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or p_payload->>'kind' not in ('day','codes') or p_payload->>'kind' is null
    or jsonb_typeof(p_payload->'orders') is distinct from 'array' then
  raise exception 'Invalid append envelope';
 end if;
 -- Also prevents disconnect/reassignment during this transaction.
 select * into strict c from public.shopify_connections where id=p_connection for share;
 if c.company_entity_id<>p_company or c.shop_domain<>p_domain or c.is_active is distinct from true or c.sync_enabled is distinct from true then
  raise exception 'Connection scope or eligibility mismatch';
 end if;
 fingerprint:=md5(p_payload::text);
 perform pg_advisory_xact_lock(hashtextextended('attribution-append:'||p_run::text,0));
 select * into receipt from public.sync_jobs where id=p_run;
 if found then
  if receipt.company_entity_id<>p_company or receipt.connection_id is distinct from p_connection
    or receipt.job_type<>'attribution_append' or receipt.params->>'fingerprint' is distinct from fingerprint
    or receipt.params->>'domain' is distinct from p_domain then raise exception 'Append receipt conflict'; end if;
  return receipt.result;
 end if;
 stamp := (p_payload->>'collected_at')::timestamptz;
 if stamp is null or stamp>now()+interval '5 minutes' then raise exception 'Invalid collection timestamp'; end if;
 if jsonb_array_length(p_payload->'orders') > (case when p_payload->>'kind'='codes' then 100 else 9999 end)
    or exists(select 1 from jsonb_array_elements(p_payload->'orders') x
      where coalesce(x->>'order_id','') !~ '^[1-9][0-9]*$')
    or (select count(distinct x->>'order_id') from jsonb_array_elements(p_payload->'orders') x)
       <>jsonb_array_length(p_payload->'orders') then raise exception 'Order bounds or identity mismatch'; end if;
 if p_payload->>'kind'='day' then
  day_date := (p_payload->>'day')::date;
  if day_date is null or nullif(p_payload->>'timezone','') is null or nullif(p_payload->>'currency','') is null
     or day_date >= (now() at time zone (p_payload->>'timezone'))::date
     or jsonb_typeof(p_payload->'ledger') is distinct from 'array' then raise exception 'Invalid complete day'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_connection::text||day_date::text,0));
  if jsonb_array_length(p_payload->'ledger')<>jsonb_array_length(p_payload->'orders')
     or (select count(distinct x->>'order_id') from jsonb_array_elements(p_payload->'ledger') x)<>jsonb_array_length(p_payload->'ledger')
     or exists(select 1 from jsonb_array_elements(p_payload->'ledger') l where
       coalesce(l->>'net_cents','') !~ '^-?[0-9]+$' or coalesce(l->>'total_cents','') !~ '^-?[0-9]+$'
       or not exists(select 1 from jsonb_array_elements(p_payload->'orders') o where o->>'order_id'=l->>'order_id')) then
   raise exception 'Ledger identity mismatch';
  end if;
  select coalesce(sum((x->>'net_cents')::bigint),0),coalesce(sum((x->>'total_cents')::bigint),0)
   into n,t from jsonb_array_elements(p_payload->'ledger') x;
  if n is distinct from (p_payload->>'net_cents')::bigint or t is distinct from (p_payload->>'total_cents')::bigint then
   raise exception 'Revenue mismatch'; end if;
  select * into old_day from public.shopify_attribution_days where connection_id=p_connection and day=day_date;
  if found then
   if old_day.company_entity_id<>p_company or old_day.currency<>p_payload->>'currency'
     or old_day.shop_timezone<>p_payload->>'timezone' or old_day.net_cents<>n or old_day.total_cents<>t
     or not (old_day.ledger @> (p_payload->'ledger') and old_day.ledger <@ (p_payload->'ledger')) then
    raise exception 'Existing day conflict; nothing replaced'; end if;
   -- Identical concurrent publication wins; do not apply its stale staged evidence.
   result:=jsonb_build_object('status','existing_day','day',day_date,'days_inserted',0,'codes_filled',0);
  end if;
 end if;
 if result is null then
  for item in select value from jsonb_array_elements(p_payload->'orders') order by value->>'order_id' loop
   codes:=case when p_payload->>'kind'='codes' then item->'discount_codes' else item#>'{evidence,order,discountCodes}' end;
   if codes='null'::jsonb then codes:=null; end if;
   if codes is not null then
    if jsonb_typeof(codes)<>'array' then raise exception 'Invalid code array'; end if;
    if jsonb_array_length(codes)>20 or exists(select 1 from jsonb_array_elements(codes) x
      where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 128)
      then raise exception 'Invalid code value'; end if;
   end if;
   if p_payload->>'kind'='day' then
    incoming:=item->'evidence';
    if jsonb_typeof(incoming) is distinct from 'object' or jsonb_typeof(incoming->'order') is distinct from 'object'
      or incoming#>>'{order,id}' is distinct from 'gid://shopify/Order/'||(item->>'order_id')
      or jsonb_typeof(incoming->'allocations') is distinct from 'object' then raise exception 'Invalid new evidence'; end if;
    if codes is not null then incoming:=incoming||jsonb_build_object('discount_codes_backfill',jsonb_build_object('collected_at',stamp,'run_id',p_run)); end if;
    row_added:=false;
    insert into public.shopify_attribution_orders(company_entity_id,connection_id,order_id,evidence,fetched_at)
     values(p_company,p_connection,item->>'order_id',incoming,stamp) on conflict(connection_id,order_id) do nothing
     returning true into row_added;
    if coalesce(row_added,false) then
     inserted:=inserted+1; if codes is null then unavailable:=unavailable+1; end if; continue;
    end if;
   end if;
   select * into old_order from public.shopify_attribution_orders
    where connection_id=p_connection and order_id=item->>'order_id' for update;
   if not found or old_order.company_entity_id<>p_company then raise exception 'Existing order scope mismatch'; end if;
   if codes is null then unavailable:=unavailable+1; continue; end if;
   if old_order.evidence#>'{order,discountCodes}' is not null and old_order.evidence#>'{order,discountCodes}'<>'null'::jsonb then
    if old_order.evidence#>'{order,discountCodes}'<>codes then raise exception 'Existing code conflict'; end if;
    kept:=kept+1; continue;
   end if;
   if jsonb_typeof(old_order.evidence->'order') is distinct from 'object' then raise exception 'Missing order object'; end if;
   update public.shopify_attribution_orders set evidence=jsonb_set(evidence,'{order,discountCodes}',codes)
     ||jsonb_build_object('discount_codes_backfill',jsonb_build_object('collected_at',stamp,'run_id',p_run))
    where company_entity_id=p_company and connection_id=p_connection and order_id=item->>'order_id';
   filled:=filled+1;
  end loop;
  if p_payload->>'kind'='day' then
   insert into public.shopify_attribution_days values(p_company,p_connection,day_date,p_payload->>'currency',p_payload->>'timezone',p_payload->'ledger',n,t,stamp);
   day_added:=1;
  end if;
  result:=jsonb_build_object('status','applied','days_inserted',day_added,'orders_inserted',inserted,'codes_filled',filled,'codes_preserved',kept,'codes_unavailable',unavailable);
 end if;
 insert into public.sync_jobs(id,company_entity_id,connection_id,job_type,status,params,result,started_at,finished_at)
 values(p_run,p_company,p_connection,'attribution_append','success',jsonb_build_object('fingerprint',fingerprint,'domain',p_domain,'kind',p_payload->>'kind','day',day_date),result,now(),now());
 return result;
end $$;
revoke all on function public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.append_shopify_attribution(uuid,uuid,text,uuid,jsonb) to service_role;
