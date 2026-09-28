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

select public.attach_stamp_company_entity_id_triggers();
