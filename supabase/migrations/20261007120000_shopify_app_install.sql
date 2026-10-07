-- Shopify-initiated install of SILO's PUBLIC app. ADDITIVE: nothing in the
-- existing Integrations flow reads or writes these objects.
--
-- Shopify's App Store review requires OAuth to start the moment Shopify opens
-- the app (2.3.2 / 2.3.4) and forbids asking for the store domain (2.3.1). At
-- that moment SILO knows the store, not the person or the company, so the
-- existing shopify_oauth_states (company_entity_id and user_id NOT NULL)
-- cannot hold the round trip. Two service-role-only tables do instead, plus
-- one function that moves a parked token onto a workspace's connection.
-- Design: scripts/lib/shopify-install-lib.mjs.

-- 1. OAuth state for a Shopify-initiated install: the store only.
create table if not exists public.shopify_install_states (
  nonce       text primary key,
  shop_domain text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes'
);
alter table public.shopify_install_states enable row level security;
revoke all on public.shopify_install_states from anon, authenticated;

-- 2. A token Shopify issued, waiting for an admin to say which workspace it
-- belongs to. claim_hash is sha256 of a one-time token that only the
-- installing browser ever held (in a URL fragment). Nothing here is
-- company-scoped yet, so there is no company_entity_id and no stamp trigger.
-- ONE row per store, newest wins: the install callback upserts on
-- shop_domain, so a reinstall replaces the earlier parked token and the
-- earlier claim link stops working. Otherwise an old tab, claimed after a
-- newer install, would write a token Shopify had already revoked over the
-- live one (review finding, 2026-10-07).
create table if not exists public.shopify_pending_installs (
  id             uuid primary key default gen_random_uuid(),
  claim_hash     text not null unique check (claim_hash ~ '^[0-9a-f]{64}$'),
  shop_domain    text not null unique,
  access_token   text not null,
  scopes_granted jsonb not null default '[]',
  shop_name      text,
  shop_currency  text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours'
);
alter table public.shopify_pending_installs enable row level security;
revoke all on public.shopify_pending_installs from anon, authenticated;
create index if not exists shopify_pending_installs_expires_idx
  on public.shopify_pending_installs (expires_at);

-- 3. Claim: move one parked token onto (company, shop), in one transaction.
-- The CALLER (shopify-install-claim) has already established that p_user may
-- connect a store for p_company (mayConnect); this function is service-role
-- only and decides only what the existing connection allows:
--   no live connection            -> 'connected' (new row, sync OFF)
--   live, this public app          -> 'refreshed' (new token, sync kept)
--   live, any other way            -> 'connected_other_way', nothing changes
--                                     and the claim stays usable for another
--                                     workspace until it expires
--   claim unknown / expired / used -> 'expired'
create or replace function public.shopify_claim_pending_install(
  p_claim_hash text, p_company uuid, p_user uuid)
returns table (outcome text, connection_id uuid, shop_domain text)
language plpgsql security definer set search_path = public as $$
declare
  v_p  public.shopify_pending_installs;
  v_c  public.shopify_connections;
  v_id uuid;
begin
  select * into v_p from public.shopify_pending_installs p
   where p.claim_hash = p_claim_hash for update;
  if not found or v_p.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::text;
    return;
  end if;

  -- The existing shopify_connections update trigger stamps updated_by from
  -- auth.uid(), which is null for this service-role call. Name the admin who
  -- claimed the install for the rest of THIS transaction only (is_local).
  -- Before the lookup below: PERFORM resets FOUND.
  perform set_config('request.jwt.claim.sub', p_user::text, true);

  select * into v_c from public.shopify_connections c
   where c.company_entity_id = p_company and c.shop_domain = v_p.shop_domain
   for update;

  if found and v_c.is_active is true
     and not (v_c.auth_method is not distinct from 'oauth' and v_c.oauth_app is not distinct from 'public') then
    return query select 'connected_other_way'::text, v_c.id, v_p.shop_domain;
    return;
  end if;

  if found then
    -- A closed connection of another kind may still hold its app's secret.
    delete from public.shopify_client_credentials cc where cc.connection_id = v_c.id;
    update public.shopify_connections c set
      access_token      = v_p.access_token,
      auth_method       = 'oauth',
      oauth_app         = 'public',
      token_expires_at  = null,
      shop_name         = coalesce(v_p.shop_name, c.shop_name),
      shop_currency     = coalesce(v_p.shop_currency, c.shop_currency),
      scopes_granted    = v_p.scopes_granted,
      scopes_missing    = '[]',
      scopes_checked_at = now(),
      is_active         = true,
      updated_by        = p_user,
      -- a reinstall of the same app keeps the workspace's sync choice; a
      -- connection reopened from closed starts with sync off
      sync_enabled      = case when v_c.is_active is true then c.sync_enabled else false end
    where c.id = v_c.id
    returning c.id into v_id;
    delete from public.shopify_pending_installs p where p.id = v_p.id;
    return query select (case when v_c.is_active is true then 'refreshed' else 'connected' end)::text,
                        v_id, v_p.shop_domain;
    return;
  end if;

  insert into public.shopify_connections (
    company_entity_id, shop_domain, access_token, auth_method, oauth_app, token_expires_at,
    shop_name, shop_currency, scopes_granted, scopes_missing, scopes_checked_at,
    is_active, sync_enabled, created_by)
  values (
    p_company, v_p.shop_domain, v_p.access_token, 'oauth', 'public', null,
    v_p.shop_name, v_p.shop_currency, v_p.scopes_granted, '[]', now(),
    true, false, p_user)
  returning id into v_id;
  delete from public.shopify_pending_installs p where p.id = v_p.id;
  return query select 'connected'::text, v_id, v_p.shop_domain;
end;
$$;
revoke all on function public.shopify_claim_pending_install(text, uuid, uuid) from public, anon, authenticated;

-- 4. Expired rows are removed by the install function on each call; this is
-- the same delete for a person tidying by hand.
create or replace function public.shopify_purge_expired_installs()
returns integer language sql security definer set search_path = public as $$
  with s as (delete from public.shopify_install_states where expires_at <= now() returning 1),
       p as (delete from public.shopify_pending_installs where expires_at <= now() returning 1)
  select ((select count(*) from s) + (select count(*) from p))::integer;
$$;
revoke all on function public.shopify_purge_expired_installs() from public, anon, authenticated;
