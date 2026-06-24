-- Temporary state table for Shopify OAuth CSRF protection.
-- Rows are single-use and expire after 10 minutes.
create table if not exists public.shopify_oauth_states (
  nonce             text primary key,
  company_entity_id uuid not null references public.entities(id),
  user_id           uuid not null references auth.users(id),
  shop_domain       text not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '10 minutes')
);

alter table public.shopify_oauth_states enable row level security;

-- Only service role can read/write (callback uses service role key)
-- No anon or authenticated policies needed.
