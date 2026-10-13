-- Incremental windows only. Fetching happens before this transaction.
-- No freshness arbitration: the last publisher wins. History/edge writers do
-- not acquire this lock. Requires the existing paid/terms order migrations.
create or replace function public.shopify_publish_incremental_window(
  p_connection_id uuid, p_company_entity_id uuid, p_shop_domain text,
  p_start date, p_end date, p_orders jsonb, p_lines jsonb, p_sales jsonb, p_metadata jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  payload jsonb;
  item jsonb;
  relation_name text;
  allowed text[];
  required text[];
  conflict_columns text;
  keys text[];
  grouped record;
  columns_sql text;
  updates_sql text;
  written integer;
  metadata_key text;
  shared_keys constant text[] := array['company_entity_id','connection_id','shop_domain','synced_at','sync_batch_id'];
  order_ids jsonb;
  expanded_bytes bigint := 0;
  metadata_bytes bigint;
begin
  if p_connection_id is null or p_company_entity_id is null
     or nullif(p_shop_domain, '') is null or p_start is null or p_end is null
     or p_end < p_start then
    raise exception 'Invalid Shopify publication scope';
  end if;
  if jsonb_typeof(p_orders) is distinct from 'array'
     or jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_typeof(p_sales) is distinct from 'array' then
    raise exception 'Shopify publication requires three arrays';
  end if;
  -- JSONB text includes whitespace, so this server bound is deliberately
  -- conservative relative to the caller's compact UTF-8 request bound.
  if octet_length(jsonb_build_object('p_connection_id',p_connection_id,'p_company_entity_id',p_company_entity_id,
       'p_shop_domain',p_shop_domain,'p_start',p_start,'p_end',p_end,'p_orders',p_orders,
       'p_lines',p_lines,'p_sales',p_sales,'p_metadata',p_metadata)::text) > 16777216
     or jsonb_array_length(p_orders) > 10000 or jsonb_array_length(p_lines) > 50000
     or jsonb_array_length(p_sales) > 50000 then
    raise exception 'Shopify publication payload exceeds limit';
  end if;

  if jsonb_typeof(p_metadata) is distinct from 'object'
     or not (p_metadata ?& array['orders','lines','sales'])
     or exists(select 1 from jsonb_object_keys(p_metadata) k where k <> all(array['orders','lines','sales'])) then
    raise exception 'Invalid Shopify shared metadata';
  end if;
  -- Expand within this same transaction only after bounding the entire compact
  -- request. Shared metadata is never a default: absent keys stay absent.
  foreach metadata_key in array array['orders','lines','sales'] loop
    if jsonb_typeof(p_metadata->metadata_key) is distinct from 'object'
       or exists(select 1 from jsonb_object_keys(p_metadata->metadata_key) k where k <> all(shared_keys)) then
      raise exception 'Invalid Shopify shared metadata columns';
    end if;
    payload := case metadata_key when 'orders' then p_orders when 'lines' then p_lines else p_sales end;
    if exists(select 1 from jsonb_each(p_metadata->metadata_key) kv
       where jsonb_typeof(kv.value) not in ('string','null')) then
      raise exception 'Shopify shared metadata must contain strings or null';
    end if;
    if jsonb_array_length(payload) > 0 and (
       p_metadata->metadata_key->>'company_entity_id' is distinct from p_company_entity_id::text
       or p_metadata->metadata_key->>'shop_domain' is distinct from p_shop_domain
       or (metadata_key <> 'sales' and p_metadata->metadata_key->>'connection_id' is distinct from p_connection_id::text)) then
      raise exception 'Shopify shared metadata scope mismatch';
    end if;
    if exists(select 1 from jsonb_array_elements(payload) r
       where jsonb_typeof(r) is distinct from 'object' or r ?| shared_keys) then
      raise exception 'Shopify row overrides shared metadata';
    end if;
    metadata_bytes := octet_length((p_metadata->metadata_key)::text);
    select expanded_bytes + coalesce(sum(octet_length(value::text)),0)
      + jsonb_array_length(payload)::bigint * (metadata_bytes + 4) + 2
      into expanded_bytes from jsonb_array_elements(payload);
    -- Separate finite expansion guard, not a relaxation of the 16MiB wire cap.
    -- Check BEFORE allocation; repeated metadata must not amplify a tiny
    -- request into unbounded server memory. The 10k fixture expands to ~21MiB.
    if expanded_bytes > 33554432 then raise exception 'Shopify expanded payload exceeds limit'; end if;
    select coalesce(jsonb_agg(value || (p_metadata->metadata_key)), '[]'::jsonb)
      into payload from jsonb_array_elements(payload);
    case metadata_key when 'orders' then p_orders := payload;
      when 'lines' then p_lines := payload; else p_sales := payload; end case;
  end loop;

  -- Build one lookup rather than re-scanning all headers for every line.
  select coalesce(jsonb_object_agg(value->>'order_id', true), '{}'::jsonb) into order_ids
    from jsonb_array_elements(p_orders) where nullif(value->>'order_id','') is not null;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'shopify-incremental:' || p_company_entity_id::text || ':' || p_shop_domain, 0));
  -- Retain the connection scope until commit (including concurrent ownership
  -- edits/deletion). Never trust only the scope supplied in the request.
  perform 1 from public.shopify_connections
    where id = p_connection_id and company_entity_id = p_company_entity_id
      and shop_domain = p_shop_domain for share;
  if not found then raise exception 'Shopify connection scope mismatch'; end if;

  for relation_name, payload in
    select 'shopify_orders', p_orders union all
    select 'shopify_order_lines', p_lines union all select 'sales_by_day', p_sales
  loop
    if relation_name = 'shopify_orders' then
      allowed := string_to_array('company_entity_id,connection_id,shop_domain,order_id,order_number,source_name,financial_status,fulfillment_status,cancelled_at,cancel_reason,customer_id,customer_email,customer_name,currency,subtotal_price,total_discounts,total_tax,total_shipping,total_price,tags,location_id,line_item_count,shopify_created_at,shopify_processed_at,shopify_updated_at,payment_terms_status,payment_terms_name,payment_terms_type,payment_due_in_days,payment_due_at,payment_terms_completed_at,total_outstanding,paid_at,paid_at_checked_at,synced_at,sync_batch_id', ',');
      required := array['company_entity_id','connection_id','shop_domain','order_id'];
    elsif relation_name = 'shopify_order_lines' then
      allowed := string_to_array('company_entity_id,connection_id,shop_domain,order_id,line_item_id,sku,product_id,variant_id,title,variant_title,quantity,price,discount_allocated,tax_allocated,fulfillable_quantity,fulfillment_status,gift_card,vendor,product_type,synced_at,sync_batch_id', ',');
      required := array['company_entity_id','connection_id','shop_domain','order_id','line_item_id'];
    else
      allowed := string_to_array('company_entity_id,location_tag,location_name,source,day_date,product_name,sku,product_type,vendor_original,total_quantity_sold,total_orders,total_gross_sales,total_discounts,total_refunds,total_net_sales,taxes,shipping,total_sales,shop_domain,sync_batch_id,synced_at,row_hash', ',');
      required := array['company_entity_id','shop_domain','source','day_date','total_orders','row_hash'];
    end if;
    for item in select value from jsonb_array_elements(payload) loop
      if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid Shopify row'; end if;
      select array_agg(k order by k) into keys from jsonb_object_keys(item) as k;
      if not (keys <@ allowed) or not (keys @> required)
         or item->>'company_entity_id' is distinct from p_company_entity_id::text
         or item->>'shop_domain' is distinct from p_shop_domain then
        raise exception 'Shopify row scope or columns mismatch';
      end if;
      if relation_name <> 'sales_by_day' then
        if item->>'connection_id' is distinct from p_connection_id::text
           or nullif(item->>'order_id', '') is null then
          raise exception 'Shopify order scope mismatch';
        end if;
        if relation_name = 'shopify_order_lines' and (
          nullif(item->>'line_item_id', '') is null or not (order_ids ? (item->>'order_id'))) then
          raise exception 'Shopify line has no published parent';
        end if;
      elsif item->>'source' is distinct from 'shopify_api'
         or nullif(item->>'row_hash', '') is null or (item->>'day_date')::date is null
         or (item->>'total_orders')::numeric is null or (item->>'total_orders')::numeric < 0
         or ((item->>'total_orders')::numeric > 0 and
             (item->>'day_date')::date not between p_start and p_end) then
        raise exception 'Shopify sales row outside publication scope';
      end if;
    end loop;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_orders) o group by o->>'order_id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(p_lines) l group by l->>'order_id',l->>'line_item_id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(p_sales) s group by s->>'row_hash' having count(*) > 1) then
    raise exception 'Duplicate Shopify publication keys';
  end if;
  -- Existing legacy conflict keys omit company: refuse an ownership collision
  -- instead of moving another company's record via ON CONFLICT.
  if exists (select 1 from public.shopify_orders o join jsonb_array_elements(p_orders) r
       on o.shop_domain = p_shop_domain and o.order_id = r->>'order_id'
       where o.company_entity_id is distinct from p_company_entity_id)
     or exists (select 1 from public.shopify_order_lines l join jsonb_array_elements(p_orders) r
       on l.shop_domain = p_shop_domain and l.order_id = r->>'order_id'
       where l.company_entity_id is distinct from p_company_entity_id)
     or exists (select 1 from public.sales_by_day s join jsonb_array_elements(p_sales) r
       on s.row_hash = r->>'row_hash' where s.company_entity_id is distinct from p_company_entity_id
         or s.shop_domain is distinct from p_shop_domain or s.source is distinct from 'shopify_api') then
    raise exception 'Existing Shopify key belongs to another scope';
  end if;

  delete from public.sales_by_day where company_entity_id = p_company_entity_id
    and shop_domain = p_shop_domain and source = 'shopify_api' and total_orders > 0
    and day_date between p_start and p_end;
  delete from public.shopify_order_lines where company_entity_id = p_company_entity_id
    and shop_domain = p_shop_domain and order_id in
      (select o->>'order_id' from jsonb_array_elements(p_orders) o);

  for relation_name, payload, conflict_columns in
    select 'shopify_orders', p_orders, 'shop_domain,order_id' union all
    select 'shopify_order_lines', p_lines, 'shop_domain,order_id,line_item_id' union all
    select 'sales_by_day', p_sales, 'row_hash'
  loop
    -- Group by PRESENT keys. In particular, absent paid_at must preserve the
    -- old value while explicit JSON null must clear it. Never fill absent keys.
    for grouped in
      select array(select jsonb_object_keys(value) order by 1) as cols, jsonb_agg(value) as rows
      from jsonb_array_elements(payload) group by 1
    loop
      select string_agg(format('%I', k), ','), string_agg(format('%I = excluded.%I', k, k), ',')
        into columns_sql, updates_sql from unnest(grouped.cols) k;
      execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)
        on conflict (%s) do update set %s
        where %I.company_entity_id = $2 and %I.shop_domain = $3 %s', relation_name, columns_sql, columns_sql,
        relation_name, conflict_columns, updates_sql, relation_name, relation_name,
        case when relation_name = 'sales_by_day' then 'and sales_by_day.source = ''shopify_api''' else '' end)
        using grouped.rows, p_company_entity_id, p_shop_domain;
      get diagnostics written = row_count;
      if written <> jsonb_array_length(grouped.rows) then
        raise exception 'Concurrent Shopify ownership collision';
      end if;
    end loop;
  end loop;
  return jsonb_build_object('orders_upserted', jsonb_array_length(p_orders),
    'order_lines_upserted', jsonb_array_length(p_lines), 'sales_rows_upserted', jsonb_array_length(p_sales));
end;
$$;
revoke all on function public.shopify_publish_incremental_window(uuid,uuid,text,date,date,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.shopify_publish_incremental_window(uuid,uuid,text,date,date,jsonb,jsonb,jsonb,jsonb) to service_role;
comment on function public.shopify_publish_incremental_window(uuid,uuid,text,date,date,jsonb,jsonb,jsonb,jsonb)
  is 'Service-only atomic incremental window; scoped transaction lock, last publisher wins. No history/edge writer or MV freshness guarantee.';
notify pgrst, 'reload schema';
