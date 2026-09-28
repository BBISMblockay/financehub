-- Shopify connections that work for stores outside Baseballism's organization.
--
-- WHY. SILO's Shopify app is CUSTOM-distributed to Baseballism's Shopify
-- organization, so any other store gets "app may not be available for this
-- store" (reproduced 2026-09-27, onboarding Bat Nutz). The fallback -- pasting
-- a shpat_ token from a custom app made in the store admin -- stopped working
-- for new stores on 2026-01-01, when Shopify ended "Develop apps". What still
-- works for a store in its own organization is a Dev Dashboard app plus the
-- client-credentials grant: SILO holds the app's client id and secret and
-- mints a 24-hour token (scripts/lib/shopify-auth-lib.mjs).
--
-- Also here: the column that tells the OAuth callback which of SILO's two
-- Shopify apps started a flow (the legacy custom one or the new public one),
-- and the log the privacy (GDPR) webhooks write.

-- ── How a connection gets its token ─────────────────────────────────────────
alter table public.shopify_connections
  add column if not exists auth_method text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists oauth_app text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shopify_connections_auth_method_check') then
    alter table public.shopify_connections add constraint shopify_connections_auth_method_check
      check (auth_method is null or auth_method in ('oauth', 'manual_token', 'client_credentials'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shopify_connections_oauth_app_check') then
    alter table public.shopify_connections add constraint shopify_connections_oauth_app_check
      check (oauth_app is null or oauth_app in ('legacy', 'public'));
  end if;
end $$;

comment on column public.shopify_connections.auth_method is
  'How this connection gets its Admin API token: oauth (Connect with Shopify, never expires), manual_token (a pasted shpat_ token from a legacy custom app), client_credentials (the store''s own Dev Dashboard app; SILO mints a 24-hour token from shopify_client_credentials). NULL = made before this column, a stored token as always.';
comment on column public.shopify_connections.token_expires_at is
  'Set only for client_credentials: when access_token stops working. Refreshed before every sync.';

alter table public.shopify_oauth_states
  add column if not exists oauth_app text;
comment on column public.shopify_oauth_states.oauth_app is
  'Which SILO Shopify app started this flow (legacy / public). The callback verifies the signature and exchanges the code with THAT app''s secret. NULL = legacy.';

-- ── The store's own app credentials: service role ONLY ──────────────────────
-- A separate table rather than two columns on shopify_connections, because
-- shopify_connections is readable by every member of the company, and a client
-- secret must not be. RLS on with no policy at all, and no grant: only the
-- service role (edge functions, syncs) can read it. Written only by the
-- shopify-connect-dev-app function, after Shopify has accepted the pair.
create table if not exists public.shopify_client_credentials (
  connection_id uuid primary key references public.shopify_connections(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id),
  client_id text not null,
  client_secret text not null,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table public.shopify_client_credentials enable row level security;
revoke all on public.shopify_client_credentials from anon, authenticated;
comment on table public.shopify_client_credentials is
  'A store''s own Shopify Dev Dashboard app (client id + secret) for client_credentials connections. SERVICE ROLE ONLY: RLS enabled, no policy, no grant. Deleted with its connection.';

-- ── Privacy (GDPR) webhook log ──────────────────────────────────────────────
-- Every compliance webhook Shopify sends, whatever it asked for, so "did we
-- act on this request" has an answer. Service role only, like the credentials.
create table if not exists public.shopify_compliance_requests (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  topic text not null,
  shop_domain text,
  company_entity_id uuid references public.entities(id),
  action text not null,
  status text not null default 'received',
  rows_redacted integer,
  payload jsonb not null,
  note text,
  handled_at timestamptz
);
alter table public.shopify_compliance_requests enable row level security;
revoke all on public.shopify_compliance_requests from anon, authenticated;
comment on table public.shopify_compliance_requests is
  'Every Shopify compliance webhook (customers/data_request, customers/redact, shop/redact) and what SILO did: record_only (a person must answer a data request), redacted (customer name/email/id blanked on shopify_orders / shopify_draft_orders), ignored. SERVICE ROLE ONLY.';
create index if not exists shopify_compliance_requests_received_idx
  on public.shopify_compliance_requests (received_at desc);

-- ── The Admin API token is not readable by members ─────────────────────────
-- shopify_connections' SELECT policy admits every member of the company, and
-- the row carries access_token, a live Admin API token (and now one SILO
-- renews itself every 24 hours). RLS cannot hide a column, so this is done
-- with COLUMN privileges, the customer_accounts precedent: SELECT is revoked
-- from the table and re-granted on every column EXCEPT access_token. The
-- token stays writable (the pasted-token form inserts it, it never reads it)
-- and every server reader uses the service role. The column list is computed
-- at apply time, so re-running after a new column is added grants that one
-- too; verify_v2_schema.sql fails if a column is left ungranted or the token
-- becomes readable. anon gets nothing: it has no company to read.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'shopify_connections' and column_name <> 'access_token';
  execute 'revoke select on public.shopify_connections from anon, authenticated';
  execute format('grant select (%s) on public.shopify_connections to authenticated', cols);
end $$;

-- ── Writes that must land together ──────────────────────────────────────────
-- Saving a store's own app: the connection's token and the credentials that
-- renew it are ONE fact. Written as two statements, a failure between them
-- left a token from the new app beside the old app's secret -- working until
-- the next refresh, then failing. One transaction; service role only.
create or replace function public.shopify_save_client_credentials_connection(
  p_company uuid, p_shop text, p_client_id text, p_client_secret text,
  p_access_token text, p_expires_at timestamptz, p_user uuid
) returns table (connection_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_method text;
begin
  select c.id, c.auth_method into v_id, v_method
  from public.shopify_connections c
  where c.company_entity_id = p_company and c.shop_domain = p_shop
  for update;

  if v_id is not null and coalesce(v_method, '') <> 'client_credentials' then
    raise exception 'not_client_credentials' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.shopify_connections
      (company_entity_id, shop_domain, access_token, token_expires_at, auth_method, is_active, sync_enabled, created_by)
    values (p_company, p_shop, p_access_token, p_expires_at, 'client_credentials', true, false, p_user)
    returning id into v_id;
    created := true;
  else
    update public.shopify_connections
       set access_token = p_access_token, token_expires_at = p_expires_at, is_active = true, updated_by = p_user
     where id = v_id;
    created := false;
  end if;

  insert into public.shopify_client_credentials (connection_id, company_entity_id, client_id, client_secret, created_by)
  values (v_id, p_company, p_client_id, p_client_secret, p_user)
  on conflict on constraint shopify_client_credentials_pkey do update
    set client_id = excluded.client_id, client_secret = excluded.client_secret,
        company_entity_id = excluded.company_entity_id, created_by = excluded.created_by, created_at = now();

  connection_id := v_id;
  return next;
end $$;

-- Closing the connections an uninstalled app issued: deleting the renewable
-- credentials and clearing the token are ONE act, or a partial failure leaves
-- a deactivated connection that can still mint tokens. Returns how many
-- connections were closed.
create or replace function public.shopify_close_connections(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.shopify_client_credentials where connection_id = any (p_ids);
  update public.shopify_connections
     set access_token = null, token_expires_at = null, is_active = false, sync_enabled = false
   where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon and authenticated; the revoke is the boundary (20260904330000).
revoke all on function public.shopify_save_client_credentials_connection(uuid, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.shopify_close_connections(uuid[]) from public, anon, authenticated;
grant execute on function public.shopify_save_client_credentials_connection(uuid, text, text, text, text, timestamptz, uuid) to service_role;
grant execute on function public.shopify_close_connections(uuid[]) to service_role;

select public.attach_stamp_company_entity_id_triggers();
