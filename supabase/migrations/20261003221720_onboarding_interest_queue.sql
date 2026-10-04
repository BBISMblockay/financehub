-- Public landing interest is a contact queue, never a company or invite.
-- Additive and re-runnable. Deploy onboarding-interest separately, public.
begin;

create table if not exists public.onboarding_interest_queue (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_name text not null,
  email text not null unique,
  created_at timestamptz not null default now(),
  source text not null default 'landing',
  status text not null default 'pending',
  constraint onboarding_interest_name_valid check (
    name = btrim(name) and char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  constraint onboarding_interest_company_valid check (
    company_name = btrim(company_name) and char_length(company_name) between 1 and 200 and company_name !~ '[[:cntrl:]]'),
  constraint onboarding_interest_email_valid check (
    email = lower(btrim(email)) and char_length(email) between 3 and 254
    and char_length(split_part(email, '@', 1)) <= 64
    and split_part(email, '@', 1) not like '.%'
    and split_part(email, '@', 1) not like '%.'
    and split_part(email, '@', 1) not like '%..%'
    and email ~ $rx$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$$rx$),
  constraint onboarding_interest_source_valid check (source = 'landing'),
  constraint onboarding_interest_status_valid check (status in ('pending', 'contacted', 'closed'))
);
create index if not exists onboarding_interest_queue_newest_idx
  on public.onboarding_interest_queue(created_at desc, id desc);
create index if not exists onboarding_interest_queue_status_newest_idx
  on public.onboarding_interest_queue(status, created_at desc, id desc);

-- Fixed global rows are reused. Email keys are HMACs produced only at the edge;
-- no raw address, IP, headers, or user agent is stored here.
create table if not exists public.onboarding_interest_rate_buckets (
  bucket_key text primary key,
  hits integer not null check (hits between 1 and 300),
  expires_at timestamptz not null,
  constraint onboarding_interest_bucket_key_valid check (
    bucket_key in ('global:minute', 'global:day') or bucket_key ~ '^email:[0-9a-f]{64}$')
);
create index if not exists onboarding_interest_rate_expiry_idx
  on public.onboarding_interest_rate_buckets(expires_at);

alter table public.onboarding_interest_queue enable row level security;
alter table public.onboarding_interest_rate_buckets enable row level security;

-- Supabase public-schema defaults grant broad DML, including to anon. Clear
-- table AND column ACLs on rerun, then restore only the required capabilities.
revoke all on public.onboarding_interest_queue from public, anon, authenticated, service_role;
revoke all (id, name, company_name, email, created_at, source, status)
  on public.onboarding_interest_queue from public, anon, authenticated, service_role;
revoke all on public.onboarding_interest_rate_buckets from public, anon, authenticated, service_role;
revoke all (bucket_key, hits, expires_at)
  on public.onboarding_interest_rate_buckets from public, anon, authenticated, service_role;
grant select on public.onboarding_interest_queue to authenticated;
grant update (status) on public.onboarding_interest_queue to authenticated;
grant select, insert on public.onboarding_interest_queue to service_role;
grant select, insert, update, delete on public.onboarding_interest_rate_buckets to service_role;

drop policy if exists onboarding_interest_platform_select on public.onboarding_interest_queue;
create policy onboarding_interest_platform_select on public.onboarding_interest_queue
  for select to authenticated using ((select public.is_platform_admin()));
drop policy if exists onboarding_interest_platform_update on public.onboarding_interest_queue;
create policy onboarding_interest_platform_update on public.onboarding_interest_queue
  for update to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

create or replace function public.submit_onboarding_interest(
  p_name text, p_company_name text, p_email text, p_email_key text
) returns jsonb
language plpgsql security invoker
set search_path = ''
as $fn$
declare
  v_now timestamptz;
  v_key text;
  v_limit integer;
  v_window interval;
  v_hits integer;
  v_expires timestamptz;
  v_retry integer := 0;
begin
  -- Defense in depth: no caller-controlled clock, caps, source, or status.
  if p_name is null or p_name <> btrim(p_name) or char_length(p_name) not between 1 and 120 or p_name ~ '[[:cntrl:]]'
     or p_company_name is null or p_company_name <> btrim(p_company_name) or char_length(p_company_name) not between 1 and 200 or p_company_name ~ '[[:cntrl:]]'
     or p_email is null or p_email <> lower(btrim(p_email)) or char_length(p_email) not between 3 and 254
     or char_length(split_part(p_email, '@', 1)) > 64
     or split_part(p_email, '@', 1) like '.%' or split_part(p_email, '@', 1) like '%.' or split_part(p_email, '@', 1) like '%..%'
     or p_email !~ $rx$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$$rx$
     or p_email_key is null or p_email_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid interest request' using errcode = '22023';
  end if;

  -- Same lock for every invocation, acquired before reading any quota. There
  -- is no network call in this transaction; all quota checks + insert commit
  -- together. A failed insert rolls back the counters rather than saying saved.
  perform pg_catalog.pg_advisory_xact_lock(735214901, 1);
  v_now := clock_timestamp();

  delete from public.onboarding_interest_rate_buckets
  where bucket_key in (
    select bucket_key from public.onboarding_interest_rate_buckets
    where expires_at <= v_now order by expires_at limit 100
  );

  -- Check all bounds BEFORE adding any email key, limiting bucket growth even
  -- when an attacker sends a new address on every refused request.
  for v_key, v_limit in select * from (values
    ('global:minute'::text, 30), ('global:day'::text, 300), ('email:' || p_email_key, 3)
  ) as limits(bucket_key, max_hits)
  loop
    select hits, expires_at into v_hits, v_expires
      from public.onboarding_interest_rate_buckets where bucket_key = v_key;
    if found and v_expires > v_now and v_hits >= v_limit then
      v_retry := greatest(v_retry, ceil(extract(epoch from v_expires - v_now))::integer);
    end if;
  end loop;
  if v_retry > 0 then
    return jsonb_build_object('accepted', false, 'retry_after_seconds', v_retry);
  end if;

  for v_key, v_window in select * from (values
    ('global:minute'::text, interval '1 minute'),
    ('global:day'::text, interval '1 day'),
    ('email:' || p_email_key, interval '1 hour')
  ) as windows(bucket_key, duration)
  loop
    insert into public.onboarding_interest_rate_buckets as b(bucket_key, hits, expires_at)
    values(v_key, 1, v_now + v_window)
    on conflict (bucket_key) do update set
      hits = case when b.expires_at <= v_now then 1 else b.hits + 1 end,
      expires_at = case when b.expires_at <= v_now then v_now + v_window else b.expires_at end;
  end loop;

  insert into public.onboarding_interest_queue(name, company_name, email)
    values(p_name, p_company_name, p_email)
    on conflict (email) do nothing;
  -- A conflict can only be the preserved email-unique row. No submitted field
  -- overwrites it, and the response never distinguishes first/repeat requests.
  return jsonb_build_object('accepted', true, 'retry_after_seconds', 0);
end;
$fn$;
revoke all on function public.submit_onboarding_interest(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_onboarding_interest(text, text, text, text) to service_role;

comment on table public.onboarding_interest_queue is
  'Public landing contact requests; platform-admin only. Not an account, invite, tenant or marketing subscription.';
comment on table public.onboarding_interest_rate_buckets is
  'Service-only, bounded short-lived intake quotas. Email identities are HMACs; no raw IP or email.';

commit;
