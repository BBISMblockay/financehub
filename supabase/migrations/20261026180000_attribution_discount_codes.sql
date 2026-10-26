-- Discount codes on the attribution ledger.
--
-- The sync already issues one GraphQL order() query per order for the customer
-- journey; Shopify returns the applied discount codes on that same object, so
-- capturing them costs no extra request and no extra scope. This migration only
-- surfaces what the evidence now carries -- it adds no table, changes no policy,
-- and leaves every existing column of silo_attribution_ledger_v untouched.
--
-- NULL means NOT MEASURED, as everywhere else in SILO: evidence collected before
-- the sync change carries no discountCodes key, and reads as NULL. An order that
-- was collected and simply had no code reads as an empty array. Do not coalesce
-- the two: history is not "no code used", it is "we did not look".
--
-- A code is what the customer typed, not where they came from. An influencer or
-- affiliate code is a reasonable proxy for that partner; a sitewide welcome code
-- attaches itself to every channel. Any "code means channel" rule has to be an
-- explicit list someone maintains, which is why none is encoded here.
--
-- discount_codes keeps the whole array; discount_code is the first code applied,
-- for grouping. An order can carry several codes, so exploding the array across
-- rows would multiply that order's revenue -- group on discount_code, or make
-- every money measure aggregate over distinct order_id.
create or replace view public.silo_attribution_ledger_v with(security_invoker=true) as
 select d.company_entity_id,d.connection_id,d.day,d.currency,d.shop_timezone,d.extracted_at,
 l->>'order_id' as order_id,(l->>'net_cents')::bigint as net_cents,(l->>'total_cents')::bigint as total_cents,
 w.days as window_days,o.evidence->'order'->>'name' as order_name,
 coalesce(o.evidence->'allocations'->w.days::text->>'channel','Unattributed') as channel,
 o.evidence->'allocations'->w.days::text as allocation,
 o.fetched_at as evidence_fetched_at,
 case when jsonb_typeof(o.evidence->'order'->'discountCodes')='array'
      then o.evidence->'order'->'discountCodes' end as discount_codes,
 case when jsonb_typeof(o.evidence->'order'->'discountCodes')='array'
      then o.evidence->'order'->'discountCodes'->>0 end as discount_code
 from public.shopify_attribution_days d
 cross join lateral jsonb_array_elements(d.ledger) l
 cross join (values(7),(14),(30),(60)) w(days)
 left join public.shopify_attribution_orders o on o.connection_id=d.connection_id
 and o.company_entity_id=d.company_entity_id and o.order_id=l->>'order_id';
revoke all on public.silo_attribution_ledger_v from anon;
grant select on public.silo_attribution_ledger_v to authenticated,service_role;

-- Ask SILO's schema map has to learn the two new columns. Guarded so the file
-- also applies against a bare harness that holds only the attribution objects.
do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
