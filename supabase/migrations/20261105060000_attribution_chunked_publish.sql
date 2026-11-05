-- Publishing an attribution day in chunks, for days too large to send at once.
--
-- publish_shopify_attribution_day() carries a whole day -- ledger plus every
-- order's customer journey -- in one request. That works up to roughly four
-- thousand orders. 2025-11-27 on baseballism.myshopify.com is 8,231 and was
-- collected twice, an hour each time, with the publish call dying both times:
-- once as 'TypeError: fetch failed', once as a Cloudflare 520 from the Supabase
-- host. Two symptoms, one call: the payload, not the platform.
--
-- The fix splits the REQUEST without splitting the TRANSACTION. Chunks land in a
-- staging table that no reader can see; finalize promotes them into
-- shopify_attribution_orders and writes the day row in one transaction, under the
-- same advisory lock. So the day and its evidence still commit together, exactly
-- as the single call did.
--
-- Staging into a side table rather than writing evidence in place is the whole
-- point, and review cycle 1 of #1142 is why. shopify_attribution_orders is joined
-- live by silo_attribution_ledger_v, so an in-place chunk against a day that is
-- ALREADY published would change that day's channel and allocation the moment it
-- committed -- and if a later chunk failed, the ledger would sit half-updated
-- behind an unchanged extracted_at. Coverage mode re-publishes the trailing seven
-- days on every run, so that is a Black Friday refresh, not a hypothetical.
--
-- publish_shopify_attribution_day() is deliberately left exactly as it was. Days
-- small enough to send whole keep using it, so the path that has written every
-- snapshot to date is unchanged.

-- This file was merged in #1142 stating a three-argument stage function that wrote
-- evidence in place; review found that unsafe and #1143 replaced it here before it
-- was ever applied (production had neither function at the time of writing). The
-- drop is for any environment that did apply the first version: the signature has
-- changed, so CREATE OR REPLACE would leave the old one behind, still granted.
drop function if exists public.stage_shopify_attribution_orders(uuid,jsonb,timestamptz);

create table if not exists public.shopify_attribution_orders_staged (
 company_entity_id uuid not null references public.entities(id),
 connection_id uuid not null references public.shopify_connections(id) on delete cascade,
 day date not null,
 order_id text not null,
 evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
 extracted_at timestamptz not null,
 primary key(connection_id,day,order_id)
);
-- Not reader-facing: this holds one in-flight extraction, never an answer. RLS on
-- with no policy at all, so even a service of the right company reads nothing
-- through PostgREST; service_role bypasses RLS and is the only writer.
alter table public.shopify_attribution_orders_staged enable row level security;
revoke all on public.shopify_attribution_orders_staged from anon,authenticated;
grant all on public.shopify_attribution_orders_staged to service_role;

-- One chunk of one extraction. No day lock: these rows are private to the run.
create or replace function public.stage_shopify_attribution_orders(
 p_connection uuid,p_day date,p_orders jsonb,p_extracted timestamptz
) returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare co uuid;
begin
 select company_entity_id into strict co from public.shopify_connections where id=p_connection;
 if jsonb_typeof(p_orders) <> 'array' then raise exception 'Invalid evidence chunk'; end if;
 if exists(select 1 from jsonb_array_elements(p_orders) o where coalesce(o->>'order_id','')=''
           -- jsonb_typeof(NULL) is NULL, and NULL <> 'object' is NULL, not true: an order
           -- with no evidence key at all would slip an uncoalesced test and only fail
           -- later on the column's NOT NULL.
           or coalesce(jsonb_typeof(o->'evidence'),'') <> 'object') then raise exception 'Invalid evidence chunk'; end if;
 if (select count(distinct o->>'order_id') from jsonb_array_elements(p_orders) o) <> jsonb_array_length(p_orders)
  then raise exception 'Duplicate evidence'; end if;
 insert into public.shopify_attribution_orders_staged(company_entity_id,connection_id,day,order_id,evidence,extracted_at)
 select co,p_connection,p_day,o->>'order_id',o->'evidence',p_extracted from jsonb_array_elements(p_orders) o
 on conflict(connection_id,day,order_id) do update set evidence=excluded.evidence,extracted_at=excluded.extracted_at;
 return jsonb_array_length(p_orders);
end $$;

-- Promote the staged evidence and write the day row, together. Same lock, same
-- supersede rule and same reconciliation as publish_shopify_attribution_day.
create or replace function public.finalize_shopify_attribution_day(
 p_connection uuid,p_day date,p_currency text,p_timezone text,p_ledger jsonb,
 p_net bigint,p_total bigint,p_extracted timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare co uuid; n bigint; t bigint; k integer; existing timestamptz;
begin
 select company_entity_id into strict co from public.shopify_connections where id=p_connection;
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text||p_day::text,0));
 select extracted_at into existing from public.shopify_attribution_days where connection_id=p_connection and day=p_day;
 if existing is not null and existing >= p_extracted then
  -- Superseded: drop this run's staged rows rather than leave them for nobody.
  delete from public.shopify_attribution_orders_staged
   where connection_id=p_connection and day=p_day and extracted_at<=p_extracted;
  return false;
 end if;
 if jsonb_typeof(p_ledger) <> 'array' then raise exception 'Invalid snapshot'; end if;
 select coalesce(sum((x->>'net_cents')::bigint),0),coalesce(sum((x->>'total_cents')::bigint),0),count(distinct x->>'order_id')
 into n,t,k from jsonb_array_elements(p_ledger) x;
 if n <> p_net or t <> p_total or k <> jsonb_array_length(p_ledger) then raise exception 'Revenue or identity mismatch'; end if;
 -- Every order this day names must have evidence staged by THIS extraction. Checked
 -- before promotion, so a short day changes nothing at all.
 if exists(select 1 from jsonb_array_elements(p_ledger) l where coalesce(l->>'order_id','')='' or
 not exists(select 1 from public.shopify_attribution_orders_staged s
            where s.connection_id=p_connection and s.day=p_day
              and s.order_id=l->>'order_id' and s.extracted_at=p_extracted)) then
 raise exception 'Missing order evidence'; end if;
 -- Identical conflict rules to publish_shopify_attribution_day: a newer extraction
 -- wins, and a ready journey is never replaced by a not-ready one.
 insert into public.shopify_attribution_orders(company_entity_id,connection_id,order_id,evidence,fetched_at)
 select co,p_connection,s.order_id,s.evidence,p_extracted from public.shopify_attribution_orders_staged s
 where s.connection_id=p_connection and s.day=p_day and s.extracted_at=p_extracted
 on conflict(connection_id,order_id) do update set evidence=excluded.evidence,fetched_at=excluded.fetched_at
 where shopify_attribution_orders.fetched_at < excluded.fetched_at
 and not (coalesce((shopify_attribution_orders.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false)
 and not coalesce((excluded.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false));
 insert into public.shopify_attribution_days values(co,p_connection,p_day,p_currency,p_timezone,p_ledger,p_net,p_total,p_extracted)
 on conflict(connection_id,day) do update set currency=excluded.currency,shop_timezone=excluded.shop_timezone,
 ledger=excluded.ledger,net_cents=excluded.net_cents,total_cents=excluded.total_cents,extracted_at=excluded.extracted_at;
 -- This extraction's rows are spent, and anything older for the same day is an
 -- abandoned attempt. Both go, so a retried day cannot accumulate staging.
 delete from public.shopify_attribution_orders_staged
  where connection_id=p_connection and day=p_day and extracted_at<=p_extracted;
 return true;
end $$;

revoke all on function public.stage_shopify_attribution_orders(uuid,date,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.stage_shopify_attribution_orders(uuid,date,jsonb,timestamptz) to service_role;
revoke all on function public.finalize_shopify_attribution_day(uuid,date,text,text,jsonb,bigint,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.finalize_shopify_attribution_day(uuid,date,text,text,jsonb,bigint,bigint,timestamptz) to service_role;
select public.attach_stamp_company_entity_id_triggers();
