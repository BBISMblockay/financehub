-- Extra scaffolding for the customer-account onboarding suite, on top of
-- stripe-db-bootstrap.sql (which supplies auth/profiles/entities/memberships,
-- active_company_id(), is_admin_user() and the company-stamp triggers).
--
-- Two things the Stripe bootstrap has no need for:
--   * storage.buckets / storage.objects plus storage.foldername(), because the
--     resale certificate's policy is the narrow-gate claim this feature makes
--     and a policy nothing evaluates is not a policy.
--   * ar_customers, so the soft ar_customer_id link has something real to
--     point at in the "links out, never writes in" assertions.

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;

-- Supabase's own definition: the path split into its segments, so
-- (storage.foldername(name))[1] is the first folder.
create or replace function storage.foldername(name text)
returns text[] language plpgsql immutable as $$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts,1)-1];
end;
$$;

grant usage on schema storage to authenticated, anon;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- The AR sheet mirror, in the shape server/ar-sync.mjs writes it.
create table if not exists public.ar_customers (
  id uuid primary key default gen_random_uuid(),
  customer_name text,
  email text,
  company_entity_id uuid references public.entities(id)
);
alter table public.ar_customers enable row level security;
create policy ar_customers_active_select on public.ar_customers
  for select to authenticated
  using (company_entity_id = public.active_company_id());
