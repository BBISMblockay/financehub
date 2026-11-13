-- Product seeding codes through the brand's own AI (codes:create), the same
-- path every affiliate code takes (20261110160000). SILO writes nothing to
-- Shopify.
--
-- A seed code is not an affiliate code: it lives on affiliate_seed_claims
-- (20261113093000), never in affiliate_codes, so the commission resolver never
-- sees it. These two functions now ALSO list approved seed codes, with their
-- own instructions -- one use, this product only, this customer only -- and
-- record one as created. Everything they did for affiliate codes is unchanged:
-- the affiliate-code branch below is the production body as it was, verbatim.

create or replace function public.silo_api_codes_to_create(p_limit integer default 25)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_codes   json;
  v_seeds   json;
begin
  v_grant   := public.silo_api_codes_grant();
  v_company := v_grant.company_entity_id;

  select coalesce(json_agg(x order by x.requested_at, x.code), '[]'::json) into v_codes
    from (
      select c.id as code_id, c.code, c.discount_percent as percent_off,
             c.starts_on, c.ends_on, c.created_at as requested_at,
             pr.name as program, a.display_name as affiliate
        from public.affiliate_codes c
        join public.affiliate_programs pr on pr.id = c.program_id and pr.company_entity_id = v_company
        join public.affiliates a on a.id = c.affiliate_id and a.company_entity_id = v_company
       where c.company_entity_id = v_company
         and c.status = 'pending'
       order by c.created_at, c.code
       limit least(greatest(coalesce(p_limit, 25), 1), 50)) x;

  select coalesce(json_agg(y order by y.approved_at, y.code), '[]'::json) into v_seeds
    from (
      select s.id as code_id, s.code, s.discount_percent as percent_off,
             s.product_title as product, s.product_path,
             s.customer_email, 1 as usage_limit, s.decided_at as approved_at,
             pr.name as program, a.display_name as affiliate
        from public.affiliate_seed_claims s
        join public.affiliate_programs pr on pr.id = s.program_id and pr.company_entity_id = v_company
        join public.affiliates a on a.id = s.affiliate_id and a.company_entity_id = v_company
       where s.company_entity_id = v_company
         and s.state = 'approved'
       order by s.decided_at, s.code
       limit least(greatest(coalesce(p_limit, 25), 1), 50)) y;

  return json_build_object(
    'codes', v_codes,
    'timezone', public.silo_company_timezone(v_company),
    'how_to_create',
      'Create each one in the person''s Shopify store as a discount CODE (not an automatic discount): '
      || 'the exact code text, percent_off percent off the whole order, all products, starting on starts_on and '
      || 'ending at the end of ends_on (no end when ends_on is null), in the timezone given, with no minimum and '
      || 'no usage limit. If a discount with that exact code already exists in Shopify, do not create another: '
      || 'use the existing one''s id. Then call mark_affiliate_code_created with code_id and the Shopify discount '
      || 'id (gid://shopify/DiscountCodeNode/...). Only for a code you actually created or found in Shopify.',
    'seed_codes', v_seeds,
    'how_to_create_seed_codes',
      'These are NOT like the codes above. Each is a product-seeding code: create it in the person''s Shopify '
      || 'store as a discount CODE with the exact code text, percent_off percent off, applying ONLY to the one '
      || 'product named in product (product_path is its page on the store, /products/<handle>, when known), '
      || 'usable ONCE in total (usage limit 1, one use per customer), and available ONLY to the Shopify customer '
      || 'with customer_email (find that customer, or create them with that email, and select them as the only '
      || 'eligible customer). No minimum, starting now, no end date. If you cannot restrict it to that customer '
      || 'and that product, do not create it; tell the person instead. If a discount with that exact code '
      || 'already exists, use its id. Then call mark_affiliate_code_created with code_id and the Shopify '
      || 'discount id, as for the codes above.',
    'note', case when json_array_length(v_codes) = 0 and json_array_length(v_seeds) = 0 then
      'No codes are waiting. A person asks for one in Affiliate Studio (Affiliates -> Give an affiliate a code), '
      || 'or approves a product request.' end);
end;
$$;

comment on function public.silo_api_codes_to_create(integer) is
  'MCP / developer API tool (codes:create): the affiliate codes a person asked for in Affiliate Studio that are waiting to be created in Shopify (status pending), each with the discount it should give and its dates, and the instruction for creating it; plus approved product-seeding codes (one use, one product, one customer) with their own instruction. Reads only; SILO writes nothing to Shopify. 20261110160000, seed codes 20261113094000.';

revoke all on function public.silo_api_codes_to_create(integer)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_codes_to_create(integer) to silo_integration;

create or replace function public.silo_api_mark_code_created(
  p_code_id uuid,
  p_shopify_discount_id text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant   public.silo_api_grants;
  v_company uuid;
  v_user    uuid;
  v_app     text;
  v_gid     text := btrim(coalesce(p_shopify_discount_id, ''));
  v_c       record;
  v_s       record;
  v_used    integer;
begin
  v_grant   := public.silo_api_codes_grant();
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);

  -- A bare number is the same discount; store the one canonical form.
  if v_gid ~ '^[0-9]{1,20}$' then
    v_gid := 'gid://shopify/DiscountCodeNode/' || v_gid;
  end if;
  if v_gid !~ '^gid://shopify/DiscountCodeNode/[0-9]{1,20}$' then
    raise exception 'invalid_discount_id: pass the Shopify discount id, gid://shopify/DiscountCodeNode/<number>'
      using errcode = 'check_violation';
  end if;

  -- ── A product-seeding code (20261113094000) ────────────────────────────
  select s.id, s.code, s.state, s.shopify_discount_id, s.code_created_by_grant_id
    into v_s
    from public.affiliate_seed_claims s
   where s.id = p_code_id and s.company_entity_id = v_company
   for update;

  if v_s.id is not null then
    if v_s.state = 'code_ready' and v_s.code_created_by_grant_id = v_grant.id then
      return json_build_object('code_id', v_s.id, 'code', v_s.code, 'status', 'active', 'replayed', true,
        'shopify_discount_id', v_s.shopify_discount_id, 'via', v_app, 'kind', 'seed');
    end if;
    if v_s.state <> 'approved' then
      raise exception 'not_pending: only an approved seed code waiting for Shopify can be marked created; this one is %', v_s.state
        using errcode = 'check_violation';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('silo_api_writes:' || v_grant.id::text, 0));
    select count(*) into v_used
      from public.silo_api_writes w
     where w.grant_id = v_grant.id
       and w.created_at > now() - interval '1 day';
    if v_used >= public.silo_api_write_cap() then
      raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
        using errcode = 'check_violation';
    end if;

    update public.affiliate_seed_claims
       set state = 'code_ready', shopify_discount_id = v_gid, code_created_at = now(),
           code_created_by_grant_id = v_grant.id, code_created_via_app = v_app
     where id = v_s.id;

    insert into public.silo_api_writes (company_entity_id, grant_id, user_id, via, kind, target_id)
    values (v_company, v_grant.id, v_user, 'app', 'code_created', v_s.id);

    return json_build_object('code_id', v_s.id, 'code', v_s.code, 'status', 'active', 'replayed', false,
      'shopify_discount_id', v_gid, 'via', v_app, 'kind', 'seed');
  end if;

  -- ── An affiliate code: unchanged from 20261110160000 ─────────────────────
  select c.id, c.code, c.status, c.shopify_discount_id, c.shopify_created_by_grant_id
    into v_c
    from public.affiliate_codes c
   where c.id = p_code_id and c.company_entity_id = v_company
   for update;

  if v_c.id is null then
    raise exception 'unknown_code: no such affiliate code in this company'
      using errcode = 'check_violation';
  end if;

  -- Already recorded by this connection: the same answer, no second change.
  if v_c.status = 'active' and v_c.shopify_created_by_grant_id = v_grant.id then
    return json_build_object('code_id', v_c.id, 'code', v_c.code, 'status', 'active', 'replayed', true,
      'shopify_discount_id', v_c.shopify_discount_id, 'via', v_app);
  end if;

  if v_c.status <> 'pending' then
    raise exception 'not_pending: only a code waiting for Shopify (from codes_to_create) can be marked created; this one is %', v_c.status
      using errcode = 'check_violation';
  end if;

  -- One connection's writes are counted one call at a time: two calls for
  -- different codes cannot both see the last free write.
  perform pg_advisory_xact_lock(hashtextextended('silo_api_writes:' || v_grant.id::text, 0));
  select count(*) into v_used
    from public.silo_api_writes w
   where w.grant_id = v_grant.id
     and w.created_at > now() - interval '1 day';
  if v_used >= public.silo_api_write_cap() then
    raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
      using errcode = 'check_violation';
  end if;

  -- Activating it runs the overlap guard: a code another affiliate got in
  -- the meantime refuses here, in the guard's own words.
  update public.affiliate_codes
     set status = 'active', shopify_discount_id = v_gid, shopify_created_at = now(),
         shopify_created_by_grant_id = v_grant.id, shopify_created_via_app = v_app,
         changed_by = v_user
   where id = v_c.id;

  insert into public.silo_api_writes (company_entity_id, grant_id, user_id, via, kind, target_id)
  values (v_company, v_grant.id, v_user, 'app', 'code_created', v_c.id);

  return json_build_object('code_id', v_c.id, 'code', v_c.code, 'status', 'active', 'replayed', false,
    'shopify_discount_id', v_gid, 'via', v_app);
end;
$$;

revoke all on function public.silo_api_mark_code_created(uuid, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_mark_code_created(uuid, text) to silo_integration;
