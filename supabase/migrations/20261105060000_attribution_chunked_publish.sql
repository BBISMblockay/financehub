-- Publishing an attribution day in chunks, for days too large to send at once.
--
-- publish_shopify_attribution_day() carries a whole day -- ledger plus every
-- order's customer journey -- in one request. That works up to roughly four
-- thousand orders. 2025-11-27 on baseballism.myshopify.com is 8,231 and was
-- collected twice, an hour each time, with the publish call dying both times:
-- once as 'TypeError: fetch failed', once as a Cloudflare 520 from the Supabase
-- host. Two symptoms, one call: the payload, not the platform.
--
-- The fix splits the write in two WITHOUT weakening what a reader sees. Every
-- consumer reaches evidence through the day row -- silo_attribution_ledger_v
-- selects from shopify_attribution_days and LEFT JOINs the evidence, and the
-- page's journey reads look up order ids that came from that view -- so an
-- evidence row with no day row is invisible. Evidence may therefore be staged
-- ahead of the day; the day still appears in one atomic step, under the same
-- advisory lock, and only once every order it names has evidence.
--
-- publish_shopify_attribution_day() is deliberately left exactly as it was. Days
-- small enough to send whole keep using it, so the path that has written every
-- snapshot to date is unchanged.

-- Evidence only. No day row, so no day lock: the upsert's row locks are enough,
-- and chunks of the same day must not serialize against each other.
create or replace function public.stage_shopify_attribution_orders(
 p_connection uuid,p_orders jsonb,p_extracted timestamptz
) returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare co uuid;
begin
 select company_entity_id into strict co from public.shopify_connections where id=p_connection;
 if jsonb_typeof(p_orders) <> 'array' then raise exception 'Invalid evidence chunk'; end if;
 if exists(select 1 from jsonb_array_elements(p_orders) o where coalesce(o->>'order_id','')=''
           -- jsonb_typeof(NULL) is NULL, and NULL <> 'object' is NULL, not true: an order
           -- with no evidence key at all would slip past an uncoalesced test and only fail
           -- later on the column's NOT NULL.
           or coalesce(jsonb_typeof(o->'evidence'),'') <> 'object') then raise exception 'Invalid evidence chunk'; end if;
 if (select count(distinct o->>'order_id') from jsonb_array_elements(p_orders) o) <> jsonb_array_length(p_orders)
  then raise exception 'Duplicate evidence'; end if;
 -- Identical conflict rules to publish_shopify_attribution_day: a newer
 -- extraction wins, and a ready journey is never replaced by a not-ready one.
 insert into public.shopify_attribution_orders(company_entity_id,connection_id,order_id,evidence,fetched_at)
 select co,p_connection,o->>'order_id',o->'evidence',p_extracted from jsonb_array_elements(p_orders) o
 on conflict(connection_id,order_id) do update set evidence=excluded.evidence,fetched_at=excluded.fetched_at
 where shopify_attribution_orders.fetched_at < excluded.fetched_at
 and not (coalesce((shopify_attribution_orders.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false)
 and not coalesce((excluded.evidence#>>'{order,customerJourneySummary,ready}')::boolean,false));
 return jsonb_array_length(p_orders);
end $$;

-- The day row, once its evidence is already staged. Same lock, same supersede
-- rule and same reconciliation as publish_shopify_attribution_day.
create or replace function public.finalize_shopify_attribution_day(
 p_connection uuid,p_day date,p_currency text,p_timezone text,p_ledger jsonb,
 p_net bigint,p_total bigint,p_extracted timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare co uuid; n bigint; t bigint; k integer; existing timestamptz;
begin
 select company_entity_id into strict co from public.shopify_connections where id=p_connection;
 perform pg_advisory_xact_lock(hashtextextended(p_connection::text||p_day::text,0));
 select extracted_at into existing from public.shopify_attribution_days where connection_id=p_connection and day=p_day;
 if existing is not null and existing >= p_extracted then return false; end if;
 if jsonb_typeof(p_ledger) <> 'array' then raise exception 'Invalid snapshot'; end if;
 select coalesce(sum((x->>'net_cents')::bigint),0),coalesce(sum((x->>'total_cents')::bigint),0),count(distinct x->>'order_id')
 into n,t,k from jsonb_array_elements(p_ledger) x;
 if n <> p_net or t <> p_total or k <> jsonb_array_length(p_ledger) then raise exception 'Revenue or identity mismatch'; end if;
 -- Presence, not freshness. The staging upsert keeps the older row when taking
 -- the new one would downgrade a ready journey, so testing fetched_at here would
 -- reject a day whose evidence is present and better. Presence is also exactly
 -- what the ledger view needs: it LEFT JOINs, and a missing row reads as
 -- Unattributed.
 if exists(select 1 from jsonb_array_elements(p_ledger) l where coalesce(l->>'order_id','')='' or
 not exists(select 1 from public.shopify_attribution_orders o
            where o.connection_id=p_connection and o.order_id=l->>'order_id')) then
 raise exception 'Missing order evidence'; end if;
 insert into public.shopify_attribution_days values(co,p_connection,p_day,p_currency,p_timezone,p_ledger,p_net,p_total,p_extracted)
 on conflict(connection_id,day) do update set currency=excluded.currency,shop_timezone=excluded.shop_timezone,
 ledger=excluded.ledger,net_cents=excluded.net_cents,total_cents=excluded.total_cents,extracted_at=excluded.extracted_at;
 return true;
end $$;

revoke all on function public.stage_shopify_attribution_orders(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.stage_shopify_attribution_orders(uuid,jsonb,timestamptz) to service_role;
revoke all on function public.finalize_shopify_attribution_day(uuid,date,text,text,jsonb,bigint,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.finalize_shopify_attribution_day(uuid,date,text,text,jsonb,bigint,bigint,timestamptz) to service_role;
