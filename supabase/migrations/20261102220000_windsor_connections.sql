-- Windsor.ai as a tenant broker -- test phase (/v2/windsor-test.html only).
--
-- SILO holds ONE Windsor owner API key (edge function secret WINDSOR_API_KEY).
-- Each SILO company connects its own accounts (Klaviyo, TikTok, ...) through an
-- authorization link SILO mints FOR THAT COMPANY. Windsor reports which link
-- every account came in through, so the account -> company mapping is derived
-- from links SILO issued, never hand-kept and never read off a vendor payload.
--
--   windsor_links            one row per minted link: its token and its company.
--                            The token is a capability (anyone holding it can
--                            attach accounts to SILO's Windsor team), so no
--                            client role can read it at all.
--   windsor_linked_accounts  one row per Windsor account SILO has attributed.
--                            (ds_id, account_id) is unique across ALL companies:
--                            Windsor's account_id is unique per team AND data
--                            source, and one account can belong to one company.
--                            The composite foreign key makes a row's company the
--                            company of the link it came through, structurally.
--
-- Only the windsor-broker edge function (service role) writes either table.
-- Admins read their own company's accounts through RLS. Applying this turns
-- nothing on: with no WINDSOR_API_KEY and no deployed function, both tables
-- stay empty.

create table if not exists public.windsor_links (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  access_token text not null,
  allowed_source text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint windsor_links_token_uniq unique (access_token),
  constraint windsor_links_id_company_uniq unique (id, company_entity_id),
  constraint windsor_links_source_check
    check (allowed_source is null or allowed_source ~ '^[a-z0-9_]{1,64}$')
);

create table if not exists public.windsor_linked_accounts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  link_id uuid not null,
  ds_id text not null,
  account_id text not null,
  account_name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint windsor_linked_accounts_link_fk foreign key (link_id, company_entity_id)
    references public.windsor_links(id, company_entity_id) on delete cascade,
  constraint windsor_linked_accounts_account_uniq unique (ds_id, account_id),
  constraint windsor_linked_accounts_ds_check check (ds_id ~ '^[a-z0-9_]{1,64}$')
);

create index if not exists idx_windsor_linked_accounts_company
  on public.windsor_linked_accounts (company_entity_id);

alter table public.windsor_links enable row level security;
alter table public.windsor_linked_accounts enable row level security;

-- Supabase's default privileges hand every new public table to anon and
-- authenticated. Revoke first, grant second, so a client write is a hard
-- permission denial rather than an RLS "zero rows updated".
revoke all on public.windsor_links from anon, authenticated;
revoke all on public.windsor_linked_accounts from anon, authenticated;
grant select on public.windsor_linked_accounts to authenticated;
grant all on public.windsor_links, public.windsor_linked_accounts to service_role;

-- Same shape as ad_platform_connections_admin_select (20260814000000).
drop policy if exists windsor_linked_accounts_admin_select on public.windsor_linked_accounts;
create policy windsor_linked_accounts_admin_select on public.windsor_linked_accounts
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

select public.attach_stamp_company_entity_id_triggers();
