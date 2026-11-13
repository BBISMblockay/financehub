-- Review-only rollout prerequisite: apply before merging runners that require
-- these RPCs. Does not dispatch jobs or change provider credentials/data.
-- Service-role only, invoker rights; no browser lease ownership.
create table if not exists public.ad_sync_leases (
  connection_id uuid primary key references public.ad_platform_connections(id) on delete cascade,
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  owner uuid not null,
  lease_until timestamptz not null
);
alter table public.ad_sync_leases enable row level security;
revoke all on public.ad_sync_leases from public, anon, authenticated;
grant all on public.ad_sync_leases to service_role;

create or replace function public.claim_ad_sync_lease(p_connection_id uuid, p_company_id uuid, p_owner uuid, p_lease_seconds integer default 900)
returns boolean language sql security invoker set search_path = '' as $$
  with claimed as (
    insert into public.ad_sync_leases as l(connection_id, company_entity_id, owner, lease_until)
    select c.id, c.company_entity_id, p_owner,
      now() + make_interval(secs => least(3600, greatest(60, p_lease_seconds)))
    from public.ad_platform_connections c
    where c.id = p_connection_id and c.company_entity_id = p_company_id
      and c.platform = 'meta_ads' and c.is_active = true and p_owner is not null
    on conflict (connection_id) do update
      set owner = excluded.owner, lease_until = excluded.lease_until,
          company_entity_id = excluded.company_entity_id
      where l.lease_until < now()
    returning 1
  ) select exists(select 1 from claimed);
$$;
create or replace function public.renew_ad_sync_lease(p_connection_id uuid, p_company_id uuid, p_owner uuid, p_lease_seconds integer default 900)
returns boolean language sql security invoker set search_path = '' as $$
  with renewed as (
    update public.ad_sync_leases l
    set lease_until = now() + make_interval(secs => least(3600, greatest(60, p_lease_seconds)))
    where l.connection_id = p_connection_id and l.company_entity_id = p_company_id
      and l.owner = p_owner and l.lease_until > now()
      and exists (select 1 from public.ad_platform_connections c
        where c.id = l.connection_id and c.company_entity_id = p_company_id
          and c.platform = 'meta_ads' and c.is_active = true)
    returning 1
  ) select exists(select 1 from renewed);
$$;
create or replace function public.release_ad_sync_lease(p_connection_id uuid, p_company_id uuid, p_owner uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with released as (
    delete from public.ad_sync_leases
    where connection_id = p_connection_id and company_entity_id = p_company_id and owner = p_owner
    returning 1
  ) select exists(select 1 from released);
$$;

-- Deferrals do not consume failure budget; attempts remains monotonic fencing.
alter table public.integration_bootstrap_jobs add column if not exists deferrals integer not null default 0;

-- Same atomic claim for targeted dispatch and scheduled draining. attempts is
-- the fencing generation checked on every runner progress/renewal write.
create or replace function public.claim_integration_bootstrap_job(
  p_job_id uuid default null, p_limit integer default 1,
  p_lease_seconds integer default 900, p_max_attempts integer default 5
) returns setof public.integration_bootstrap_jobs
language sql security invoker set search_path = '' as $$
  update public.integration_bootstrap_jobs j
  set status = 'running', attempts = j.attempts + 1,
      lease_until = now() + make_interval(secs => least(3600, greatest(60, p_lease_seconds))),
      started_at = coalesce(j.started_at, now()), updated_at = now()
  where j.id in (
    select c.id from public.integration_bootstrap_jobs c
    where (p_job_id is null or c.id = p_job_id)
      and c.status in ('pending', 'running')
      and (c.lease_until is null or c.lease_until < now())
      and c.attempts - c.deferrals < greatest(1, p_max_attempts)
      and not exists (select 1 from public.ad_sync_leases l
        where c.integration = 'meta_ads' and l.connection_id = c.connection_id
          and l.company_entity_id = c.company_entity_id and l.lease_until > now())
    order by c.created_at limit least(5, greatest(1, p_limit))
    for update skip locked
  ) returning j.*;
$$;

alter table public.integration_bootstrap_jobs add column if not exists dispatch_requested_at timestamptz;
create or replace function public.reserve_bootstrap_dispatch(p_job_id uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with reserved as (
    update public.integration_bootstrap_jobs j set dispatch_requested_at = now()
    where j.id = p_job_id and j.integration = 'meta_ads' and j.status = 'pending'
      and (j.dispatch_requested_at is null or j.dispatch_requested_at < now() - interval '2 minutes')
      and exists (select 1 from public.ad_platform_connections c
        where c.id = j.connection_id and c.company_entity_id = j.company_entity_id
          and c.platform = 'meta_ads' and c.is_active = true and c.sync_enabled = true)
    returning 1
  ) select exists(select 1 from reserved);
$$;

revoke all on function public.claim_ad_sync_lease(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.renew_ad_sync_lease(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.release_ad_sync_lease(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.claim_integration_bootstrap_job(uuid,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.reserve_bootstrap_dispatch(uuid) from public, anon, authenticated;
grant execute on function public.claim_ad_sync_lease(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.renew_ad_sync_lease(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.release_ad_sync_lease(uuid,uuid,uuid) to service_role;
grant execute on function public.claim_integration_bootstrap_job(uuid,integer,integer,integer) to service_role;
grant execute on function public.reserve_bootstrap_dispatch(uuid) to service_role;
