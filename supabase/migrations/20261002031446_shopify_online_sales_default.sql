-- Provision a reporting location only when a sales sync needs a missing default.
-- No backfill or production data update on migration apply. Node + edge callers
-- run this with service_role; browsers may rename the resulting locations row
-- through the existing company/admin RLS, without changing its identity.
create or replace function public.ensure_shopify_sales_default(p_connection_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  c record;
  l record;
  v_code text;
  v_name text;
  v_id bigint;
  v_constraint text;
  v_attempts integer := 0;
begin
  -- The row lock serializes setup and a concurrent admin default change. Read
  -- only these columns: no credential ever leaves this function.
  select id, company_entity_id, shop_domain, shop_name, default_location_code, location_id
    into c from public.shopify_connections where id = p_connection_id for update;
  if not found or c.company_entity_id is null then
    raise exception 'Shopify connection has no company';
  end if;

  if nullif(btrim(regexp_replace(c.default_location_code, '\s+', ' ', 'g')), '') is not null then
    select location_code, location_name into l from public.locations
     where company_entity_id = c.company_entity_id
       and location_code = c.default_location_code order by id limit 1;
    return jsonb_build_object('location_tag', public.silo_location_slug(c.default_location_code),
      'location_name', coalesce(nullif(btrim(regexp_replace(l.location_name, '\s+', ' ', 'g')), ''), c.default_location_code),
      'default_location_code', c.default_location_code,
      'automatic', c.default_location_code = 'shopify_online_' || replace(c.id::text, '-', ''));
  end if;

  -- A deliberately selected SILO location is configuration, not an invitation
  -- to create a different default. Refuse cross-company / missing pointers.
  if c.location_id is not null then
    select location_code, location_name into l from public.locations
      where id = c.location_id and company_entity_id = c.company_entity_id;
    if not found then raise exception 'Configured Shopify default location is unavailable'; end if;
    v_code := l.location_code;
    v_name := coalesce(nullif(btrim(regexp_replace(l.location_name, '\s+', ' ', 'g')), ''), v_code);
  else
    select nullif(btrim(regexp_replace(title, '\s+', ' ', 'g')), '') into v_name
      from public.entities where id = c.company_entity_id and entity_type = 'company';
    if not found then raise exception 'Shopify company is unavailable'; end if;
    v_name := coalesce(v_name, nullif(btrim(regexp_replace(c.shop_name, '\s+', ' ', 'g')), ''), nullif(btrim(regexp_replace(c.shop_domain, '\s+', ' ', 'g')), ''), 'Shopify') || ' Online';
    -- Code is stable under name edits and unique across companies and stores.
    -- It is not a Shopify location id, and is never written to one.
    v_code := 'shopify_online_' || replace(c.id::text, '-', '');

    -- locations has a legacy bigint primary key without a sequence. Serialize
    -- max+1 allocation with all table writes. A stale UI allocator may already
    -- have reserved max+1; it cannot silently overwrite our row (PK). Retry a
    -- competing allocator's PK insert rather than leave half a default behind.
    lock table public.locations in share row exclusive mode;
    select id, location_name into l from public.locations
      where company_entity_id = c.company_entity_id and location_code = v_code order by id limit 1;
    if found then
      v_name := coalesce(nullif(btrim(regexp_replace(l.location_name, '\s+', ' ', 'g')), ''), v_code);
    else
      loop
        v_attempts := v_attempts + 1;
        select coalesce(max(id), 0) + 1 into v_id from public.locations;
        begin
          insert into public.locations(id, company_entity_id, location_code, location_name,
            domain, store_type, is_active)
          values(v_id, c.company_entity_id, v_code, v_name, c.shop_domain, 'online', true);
          exit;
        exception when unique_violation then
          get stacked diagnostics v_constraint = constraint_name;
          if v_constraint <> 'locations_pkey' or v_attempts >= 3 then raise; end if;
        end;
      end loop;
    end if;
  end if;

  if public.silo_location_slug(v_code) is null then
    raise exception 'Configured Shopify default location has no usable code';
  end if;
  update public.shopify_connections set default_location_code = v_code where id = c.id;
  return jsonb_build_object('location_tag', public.silo_location_slug(v_code), 'location_name', v_name,
    'default_location_code', v_code,
    'automatic', v_code = 'shopify_online_' || replace(c.id::text, '-', ''));
end;
$fn$;
revoke all on function public.ensure_shopify_sales_default(uuid) from public, anon, authenticated;
grant execute on function public.ensure_shopify_sales_default(uuid) to service_role;
comment on function public.ensure_shopify_sales_default(uuid) is
  'Service-only, atomic missing sales-default setup. Preserves explicit codes and selected SILO locations; creates a company-named online reporting location without a Shopify location id.';
