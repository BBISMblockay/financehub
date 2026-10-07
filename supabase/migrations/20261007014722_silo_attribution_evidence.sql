-- Atomic, tenant-scoped attribution evidence and Shopify sales snapshots.
create table if not exists public.shopify_attribution_orders (
 company_entity_id uuid not null references public.entities(id),
 connection_id uuid not null references public.shopify_connections(id) on delete cascade,
 order_id text not null,
 evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
 fetched_at timestamptz not null,
 primary key(connection_id, order_id)
);
create table if not exists public.shopify_attribution_days (
 company_entity_id uuid not null references public.entities(id),
 connection_id uuid not null references public.shopify_connections(id) on delete cascade,
 day date not null,
 currency text not null,
 shop_timezone text not null,
 ledger jsonb not null check(jsonb_typeof(ledger) = 'array'),
 net_cents bigint not null,
 total_cents bigint not null,
 extracted_at timestamptz not null,
 primary key(connection_id, day)
);
create index if not exists attribution_days_company_day on public.shopify_attribution_days(company_entity_id,day);
create index if not exists attribution_orders_company on public.shopify_attribution_orders(company_entity_id,connection_id);
alter table public.shopify_attribution_orders enable row level security;
alter table public.shopify_attribution_days enable row level security;
revoke all on public.shopify_attribution_orders,public.shopify_attribution_days from anon,authenticated;
grant select on public.shopify_attribution_orders,public.shopify_attribution_days to authenticated;
grant all on public.shopify_attribution_orders,public.shopify_attribution_days to service_role;
drop policy if exists attribution_orders_read on public.shopify_attribution_orders;
create policy attribution_orders_read on public.shopify_attribution_orders for select to authenticated
 using(company_entity_id = (select public.active_company_id()));
drop policy if exists attribution_days_read on public.shopify_attribution_days;
create policy attribution_days_read on public.shopify_attribution_days for select to authenticated
 using(company_entity_id = (select public.active_company_id()));

-- The complete day and evidence commit together. INVOKER + service-only grant.
create or replace function public.publish_shopify_attribution_day(
 p_connection uuid,p_day date,p_currency text,p_timezone text,p_ledger jsonb,
 p_orders jsonb,p_net bigint,p_total bigint,p_extracted timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare co uuid; n bigint; t bigint; k integer; existing timestamptz;
begin
 select company_entity_id into strict co from public.shopify_connections where id=p_connection;
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text||p_day::text,0));
 select extracted_at into existing from public.shopify_attribution_days where connection_id=p_connection and day=p_day;
 if existing is not null and existing >= p_extracted then return false; end if;
 if jsonb_typeof(p_ledger) <> 'array' or jsonb_typeof(p_orders) <> 'array' then raise exception 'Invalid snapshot'; end if;
 select coalesce(sum((x->>'net_cents')::bigint),0),coalesce(sum((x->>'total_cents')::bigint),0),count(distinct x->>'order_id')
 into n,t,k from jsonb_array_elements(p_ledger) x;
 if n <> p_net or t <> p_total or k <> jsonb_array_length(p_ledger) then raise exception 'Revenue or identity mismatch'; end if;
 if exists(select 1 from jsonb_array_elements(p_ledger) l where coalesce(l->>'order_id','')='' or
 not exists(select 1 from jsonb_array_elements(p_orders) o where o->>'order_id'=l->>'order_id')) then
 raise exception 'Missing order evidence'; end if;
 if (select count(distinct o->>'order_id') from jsonb_array_elements(p_orders) o) <> jsonb_array_length(p_orders) then raise exception 'Duplicate evidence'; end if;
 insert into public.shopify_attribution_orders(company_entity_id,connection_id,order_id,evidence,fetched_at)
 select co,p_connection,o->>'order_id',o->'evidence',p_extracted from jsonb_array_elements(p_orders) o
 on conflict(connection_id,order_id) do update set evidence=excluded.evidence,fetched_at=excluded.fetched_at
 where shopify_attribution_orders.fetched_at < excluded.fetched_at
 and not (coalesce((shopify_attribution_orders.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false)
 and not coalesce((excluded.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false));
 insert into public.shopify_attribution_days values(co,p_connection,p_day,p_currency,p_timezone,p_ledger,p_net,p_total,p_extracted)
 on conflict(connection_id,day) do update set currency=excluded.currency,shop_timezone=excluded.shop_timezone,
 ledger=excluded.ledger,net_cents=excluded.net_cents,total_cents=excluded.total_cents,extracted_at=excluded.extracted_at;
 return true;
end $$;
revoke all on function public.publish_shopify_attribution_day(uuid,date,text,text,jsonb,jsonb,bigint,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.publish_shopify_attribution_day(uuid,date,text,text,jsonb,jsonb,bigint,bigint,timestamptz) to service_role;
select public.attach_stamp_company_entity_id_triggers();
