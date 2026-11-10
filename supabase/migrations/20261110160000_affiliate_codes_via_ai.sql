-- Affiliate codes created in Shopify by the person's own AI, one store address
-- rule for every affiliate link, and ad images in the affiliate feed.
--
-- WHY. Blake, 2026-11-10, after testing a hand-built link
-- (https://www.baseballism.com/discount/test-2?redirect=...) that applied the
-- code in the cart: "wed probably need mcp your codes with agent into shopify?"
-- ... "id love to say connect to our mcp to enable these toolings!" ... "puts
-- the pressure on user to connect and utilize the tools with their own auth".
-- SILO still holds NO Shopify write access. A person asks for a code in
-- Affiliate Studio; their OWN AI, signed in to their OWN Shopify, creates it
-- there and tells SILO it did. Until then the code is "pending": it earns
-- nothing (every reader of affiliate_codes credits status = 'active' only),
-- and no portal, email or link hands it out.
--
-- And: "how is feed not showing image preview of the ads on share ... beef
-- that up". Ad Studio's images live in the PRIVATE ad-creative-images bucket,
-- which an affiliate cannot read. Sharing an ad now copies its image into a
-- PUBLIC bucket, affiliate-feed-images, at the same content-addressed path
-- (<company>/<sha256>.<ext>) -- a snapshot of exactly the picture the brand
-- chose to share, like every other field of a feed item.
--
-- WHAT CHANGES.
--   1. affiliate_codes: status 'pending', the discount the code should give
--      (percent off), and where it came from in Shopify (discount id, when,
--      which connection, "Via <app>"). The overlap guard reserves a pending
--      code too, so two affiliates cannot both wait on one code.
--   2. affiliate_program_store_url(company, program): the ONE rule for where
--      affiliate links open. The program's store address; else the company's
--      Shopify domain only when it has exactly ONE active store -- a company
--      with several (Baseballism has 20, most of them retail locations) must
--      say which, instead of SILO picking the oldest. Used by the portal feed
--      (re-stated below) and the codes email (affiliate-invite).
--   3. The codes:create scope, its two paths, and two tools on the same fence
--      as outreach:send: silo_api_codes_to_create (read the pending codes,
--      with what to create) and silo_api_mark_code_created (record one as
--      created, with the Shopify discount id; one write against the cap).
--   4. The affiliate-feed-images bucket: public read, written only by someone
--      who manages affiliate programs, inside their active company's folder.
begin;

-- ── 1. Codes waiting for Shopify ──────────────────────────────────────────
alter table public.affiliate_codes drop constraint if exists affiliate_codes_status_check;
alter table public.affiliate_codes add constraint affiliate_codes_status_check
  check (status in ('active', 'retired', 'pending'));

alter table public.affiliate_codes
  add column if not exists discount_percent numeric(5,2),
  add column if not exists shopify_discount_id text,
  add column if not exists shopify_created_at timestamptz,
  add column if not exists shopify_created_by_grant_id uuid references public.silo_api_grants(id) on delete set null,
  add column if not exists shopify_created_via_app text;

alter table public.affiliate_codes drop constraint if exists affiliate_codes_discount_percent;
alter table public.affiliate_codes add constraint affiliate_codes_discount_percent check (
  discount_percent is null or (discount_percent > 0 and discount_percent <= 100));

-- A code waiting for Shopify must say what it gives, or the AI has nothing to create.
alter table public.affiliate_codes drop constraint if exists affiliate_codes_pending_has_discount;
alter table public.affiliate_codes add constraint affiliate_codes_pending_has_discount check (
  status <> 'pending' or discount_percent is not null);

alter table public.affiliate_codes drop constraint if exists affiliate_codes_shopify_discount_id;
alter table public.affiliate_codes add constraint affiliate_codes_shopify_discount_id check (
  shopify_discount_id is null or shopify_discount_id ~ '^gid://shopify/DiscountCodeNode/[0-9]{1,20}$');

comment on column public.affiliate_codes.status is
  'active: earns for this affiliate over its window. retired: kept for history. pending (20261110160000): asked for in Affiliate Studio and waiting for the person''s own AI to create it in Shopify -- earns nothing and is handed out nowhere until it is recorded as created, which makes it active.';
comment on column public.affiliate_codes.discount_percent is
  'Percent off the order the code gives the shopper, for a code SILO asks the person''s AI to create in Shopify. Null for a code a person made in Shopify themselves. 20261110160000.';
comment on column public.affiliate_codes.shopify_discount_id is
  'The Shopify discount (gid://shopify/DiscountCodeNode/...) the person''s AI reported creating for this code. 20261110160000.';
comment on column public.affiliate_codes.shopify_created_via_app is
  'The application that created the code in Shopify, shown as "Via <app>". 20261110160000.';

-- The overlap guard, re-stated from 20261110084000 (production matches it
-- apart from CRLF) with ONE change: a pending code reserves its window too.
create or replace function public.affiliate_codes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.code := upper(btrim(new.code));
  if new.code = '' then
    raise exception 'affiliate_codes: code cannot be blank';
  end if;

  -- Retired rows keep their history but no longer reserve the window. A
  -- pending code does (20261110160000): it is about to be created in Shopify.
  if new.status in ('active', 'pending') and exists (
    select 1 from public.affiliate_codes c
    where c.company_entity_id = new.company_entity_id
      and c.code = new.code
      and c.status in ('active', 'pending')
      and c.id is distinct from new.id
      and c.affiliate_id is distinct from new.affiliate_id
      -- Half-open overlap: [starts_on, ends_on] inclusive on both ends,
      -- treating a NULL ends_on as open to the far future.
      and daterange(c.starts_on, coalesce(c.ends_on, 'infinity'::date), '[]')
          && daterange(new.starts_on, coalesce(new.ends_on, 'infinity'::date), '[]')
  ) then
    raise exception
      'affiliate_codes: % is already assigned to another affiliate over an overlapping date range', new.code
      using errcode = '23505';
  end if;

  return new;
end;
$$;

-- ── 2. Where affiliate links open ─────────────────────────────────────────
create or replace function public.affiliate_program_store_url(p_company uuid, p_program uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.store_url from public.affiliate_programs p
      where p.id = p_program and p.company_entity_id = p_company),
    -- Only when there is no doubt which store: exactly one active Shopify
    -- connection. Several (retail locations, wholesale) means the brand says.
    (select case when count(*) = 1 then 'https://' || lower(min(sc.shop_domain)) end
       from public.shopify_connections sc
      where sc.company_entity_id = p_company
        and coalesce(sc.is_active, true)
        and sc.shop_domain ~ '^[A-Za-z0-9.-]+$'))
$$;

comment on function public.affiliate_program_store_url(uuid, uuid) is
  'Where a program''s affiliate links open: its store address, else the company''s Shopify domain when the company has exactly ONE active Shopify store, else NULL (the brand must set the address in Affiliate Studio -> Share). Service role only. 20261110160000.';

revoke all on function public.affiliate_program_store_url(uuid, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_program_store_url(uuid, uuid) to service_role;

-- The portal's read, re-stated from 20261110150000 with the store chosen by
-- the rule above.
create or replace function public.affiliate_portal_feed(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_today date;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused');
  if not found then
    return null;
  end if;

  v_today := (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date;

  return jsonb_build_object(
    'store_url', public.affiliate_program_store_url(v_tok.company_entity_id, v_tok.program_id),
    'codes', (
      select coalesce(jsonb_agg(c.code order by c.starts_on desc, c.code), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id
         and c.status = 'active'
         and c.starts_on <= v_today
         and (c.ends_on is null or c.ends_on >= v_today)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind', f.kind, 'title', f.title, 'note', f.note, 'image_url', f.image_url,
               'product_path', f.product_path, 'event_on', f.event_on, 'shared_at', f.shared_at)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
               order by f.shared_at desc
               limit 60) f));
end;
$$;

comment on function public.affiliate_portal_feed(text) is
  'For the affiliate-portal function: the feed of a valid portal link of an active or paused affiliate -- the items its program shared, the store address (affiliate_program_store_url), and the affiliate''s codes in effect today. NULL for anything else. Service role only. 20261110150000; store rule 20261110160000.';

revoke all on function public.affiliate_portal_feed(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_feed(text) to service_role;

-- ── 3. The codes:create scope ─────────────────────────────────────────────
-- Re-stated from 20261110093000 (production matches it) with ONE line
-- changed: c_offered.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000 (the query tool).
  -- work:write since 20261104230000: creating a task. Asked for separately on
  -- the consent screen and never implied by a read scope.
  -- outreach:send since 20261110093000: taking approved affiliate outreach to
  -- send from the person's own mailbox, and recording that it was sent. Its
  -- own box on the consent screen, never implied by work:write.
  -- codes:create since 20261110160000: reading the affiliate codes a person
  -- asked to have created in Shopify, and recording each one the person's own
  -- AI created there. Its own box; never implied by another scope.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_app     text;
  v_gen     integer;
  v_limit   integer;
  v_slot    integer;
  v_evict   uuid;
  v_id      uuid;
begin
  -- A connection can never approve anything, least of all itself.
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := auth.uid();
  if v_user is null then
    raise exception 'not_authenticated: sign in to approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: open the company you are approving access for'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_user and em.entity_id = v_company) then
    raise exception 'not_a_member: you are not a member of that company'
      using errcode = 'insufficient_privilege';
  end if;

  -- The assurance of the session doing the approving, as the session itself
  -- reports it. An OAuth token reads aal1 forever, so the only evidence
  -- two-factor approval happened is what was true HERE, at this moment.
  v_aal := coalesce(nullif(public.silo_api_claims() ->> 'aal', ''), 'aal1');
  if v_aal <> 'aal2' then
    raise exception 'mfa_required: finish two-step login before approving API access'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_client_id), '') = '' then
    raise exception 'invalid_client: no application was named'
      using errcode = 'check_violation';
  end if;

  -- Scopes are an allowlist, deduplicated, and never empty.
  select coalesce(array_agg(distinct sc), '{}')
    into v_scopes
  from unnest(coalesce(p_scopes, '{}'::text[])) sc
  where sc = any(c_offered);

  -- An unrecognised scope is REFUSED, not dropped. Measured on production
  -- 2026-11-04: an approval that ticked "also let it open tasks" stored the two
  -- read scopes and nothing else, because the page was running an older cached
  -- copy of v2/api-connections.js in which the constant for the write scope did
  -- not exist yet -- so it sent a null, this filter dropped it, and the person
  -- was told the connection was approved with a permission it did not have.
  -- Storing FEWER permissions than the person ticked, silently, is the worst
  -- outcome available here: failing in front of them costs one reload.
  if exists (
    select 1
    from unnest(coalesce(p_scopes, '{}'::text[])) sc
    where sc is null or sc <> all(c_offered)) then
    raise exception 'unknown_scope: SILO does not recognise one of the permissions this page asked for. Reload the approval page and approve again.'
      using errcode = 'check_violation';
  end if;

  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- Up to silo_api_app_connection_limit() live connections per person per
  -- APPLICATION (20261102180000, slots 20261104020000).
  v_app   := public.silo_api_app_key(p_client_id);
  v_limit := public.silo_api_app_connection_limit();

  perform pg_advisory_xact_lock(
    hashtextextended(v_app || ':' || v_user::text, 0));

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  -- Rule 1: an authorization that never received a token is nobody's
  -- connection.
  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null
     and auth_session_id is null
     and last_used_at is null;

  -- Rule 1b: this person's live grant for THIS SAME client registration.
  update public.silo_api_grants
     set revoked_at = now()
   where client_id = trim(p_client_id)
     and user_id = v_user
     and revoked_at is null;

  -- Rule 2: the lowest free slot, or the least recently used connection's.
  select s.n into v_slot
  from generate_series(0, v_limit - 1) as s(n)
  where not exists (
    select 1 from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot = s.n)
  order by s.n
  limit 1;

  if v_slot is null then
    select g.id, g.slot into v_evict, v_slot
    from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot < v_limit
    order by g.last_used_at desc nulls last, g.consented_at desc, g.id
    offset greatest(v_limit - 1, 0)
    limit 1;

    if v_evict is null then
      raise exception 'no_connection_slot: disconnect one of your existing connections to this application first'
        using errcode = 'check_violation';
    end if;

    update public.silo_api_grants
       set revoked_at = now()
     where id = v_evict
       and revoked_at is null;
  end if;

  insert into public.silo_api_grants
    (client_id, app_key, slot, user_id, company_entity_id, auth_session_id,
     generation, scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_app, v_slot, v_user, v_company, null,
     v_gen + 1, v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write, outreach:send, codes:create) and a scope outside it is REFUSED rather than dropped, up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000; strict scopes 20261104234500; outreach:send 20261110093000; codes:create 20261110160000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- Re-stated from 20261110093000 with two paths added.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task',
    '/rpc/silo_api_scopes',
    '/rpc/silo_api_claim_outreach',
    '/rpc/silo_api_mark_outreach_sent',
    '/rpc/silo_api_codes_to_create',
    '/rpc/silo_api_mark_code_created')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), opening a task (work:write), reading this connection''s own scopes (no scope needed -- it is what the server lists tools from), claiming approved affiliate outreach and marking it sent (outreach:send), and reading affiliate codes waiting for Shopify and recording one as created (codes:create). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000; scopes 20261104234500; outreach 20261110093000; codes 20261110160000.';

alter table public.silo_api_writes drop constraint if exists silo_api_writes_kind_check;
alter table public.silo_api_writes
  add constraint silo_api_writes_kind_check check (kind in ('task', 'outreach_claim', 'code_created'));

-- The fence of the codes:create tools: silo_api_outreach_grant()'s checks,
-- for this scope. Returns the live grant, or raises with a reason a bot can
-- show the person.
create or replace function public.silo_api_codes_grant()
returns public.silo_api_grants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant public.silo_api_grants;
begin
  -- Scope first: this is also what records the call (20261103240000).
  perform public.silo_api_require_scope('codes:create');

  if not public.silo_api_is_integration() then
    raise exception 'not_a_connection: this tool is for approved AI connections; use Affiliate Studio in SILO'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_grant from public.silo_api_grant() limit 1;
  if v_grant.id is null then
    raise exception 'integration_revoked: this connection is no longer approved'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.writes_paused_at is not null then
    raise exception 'writes_paused: writing is switched off for this connection in Connected apps'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.company_entity_id is null or v_grant.user_id is null then
    raise exception 'integration_revoked: this connection is not bound to a company'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_grant.user_id and em.entity_id = v_grant.company_entity_id) then
    raise exception 'not_a_member: the person who approved this connection is no longer in that company'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.affiliate_can_manage_for(v_grant.user_id, v_grant.company_entity_id) then
    raise exception 'not_an_affiliate_manager: the person who approved this connection does not manage affiliate programs in this company'
      using errcode = 'insufficient_privilege';
  end if;
  return v_grant;
end;
$$;

comment on function public.silo_api_codes_grant() is
  'The shared fence of the codes:create tools: scope, a live unpaused grant bound to a company, the approver still a member, and the Affiliate Studio manager rule for that company. Internal. 20261110160000.';

revoke all on function public.silo_api_codes_grant()
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ── 4. Read the codes waiting for Shopify ─────────────────────────────────
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
    'note', case when json_array_length(v_codes) = 0 then
      'No codes are waiting. A person asks for one in Affiliate Studio (Affiliates -> Give an affiliate a code).' end);
end;
$$;

comment on function public.silo_api_codes_to_create(integer) is
  'MCP / developer API tool (codes:create): the affiliate codes a person asked for in Affiliate Studio that are waiting to be created in Shopify (status pending), each with the discount it should give and its dates, and the instruction for creating it. Reads only; SILO writes nothing to Shopify. 20261110160000.';

revoke all on function public.silo_api_codes_to_create(integer)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_codes_to_create(integer) to silo_integration;

-- ── 5. Record one as created ──────────────────────────────────────────────
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

comment on function public.silo_api_mark_code_created(uuid, text) is
  'MCP / developer API tool (codes:create): records ONE pending affiliate code as created in Shopify by the person''s own AI, with the Shopify discount id, which makes it active (earning, and handed out in the portal). Tagged with the app ("Via <app>"); one write against silo_api_write_cap(); repeating it returns the first record. Refuses a code that is not pending. 20261110160000.';

revoke all on function public.silo_api_mark_code_created(uuid, text)
  from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_mark_code_created(uuid, text) to silo_integration;

-- ── 5b. One cap for every writer ──────────────────────────────────────────
-- create_task, claim_outreach and mark_code_created each count the rolling
-- day's writes before they write. Two of them running at once for the same
-- connection could both see the last free write. This trigger is the one
-- place they all pass through: it takes the connection's write lock (the same
-- key mark_code_created takes) and recounts, so the cap holds whichever tools
-- race. Writers keep their own early check for a friendly refusal.
create or replace function public.silo_api_writes_cap_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
begin
  if new.grant_id is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('silo_api_writes:' || new.grant_id::text, 0));
  select count(*) into v_used
    from public.silo_api_writes w
   where w.grant_id = new.grant_id
     and w.created_at > now() - interval '1 day';
  if v_used >= public.silo_api_write_cap() then
    raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.silo_api_writes_cap_guard() is
  'BEFORE INSERT on silo_api_writes: serializes one connection''s writes on its write lock and refuses a write past silo_api_write_cap() in the rolling day, whichever tool (task, outreach claim, code created) writes it. 20261110160000.';

revoke all on function public.silo_api_writes_cap_guard() from public, anon, authenticated, silo_integration, silo_revoked;

drop trigger if exists silo_api_writes_cap_guard on public.silo_api_writes;
create trigger silo_api_writes_cap_guard
  before insert on public.silo_api_writes
  for each row execute function public.silo_api_writes_cap_guard();

-- ── 6. Images an affiliate may see ────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('affiliate-feed-images', 'affiliate-feed-images', true, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "affiliate feed images written by program managers" on storage.objects;
create policy "affiliate feed images written by program managers"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'affiliate-feed-images'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.can_manage_affiliate_programs());

drop policy if exists "affiliate feed images removed by program managers" on storage.objects;
create policy "affiliate feed images removed by program managers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'affiliate-feed-images'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.can_manage_affiliate_programs());

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

notify pgrst, 'reload schema';

commit;
