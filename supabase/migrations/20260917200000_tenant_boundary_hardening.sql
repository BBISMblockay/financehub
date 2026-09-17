-- =============================================================================
-- Tenant boundary hardening — close the cross-tenant paths that do not run
-- through RLS at all, and stop the last silent falls-back-to-Baseballism.
--
-- WHY THIS EXISTS
-- RLS on the base tables is in good shape: every public base table has RLS
-- enabled, and every company-scoped policy AND-s in
-- `company_entity_id = active_company_id()`. The holes found on 2026-09-17 were
-- all in the layer BESIDE RLS -- SECURITY DEFINER functions, which run as the
-- function owner and therefore bypass RLS entirely. Their only boundary is the
-- EXECUTE grant, and Supabase's default privileges on the `public` schema grant
-- EXECUTE to `public` (hence anon + authenticated) on every newly created
-- function unless it is revoked explicitly. That is the same hazard that put
-- `chat_run_readonly_query` in anon's hands (20260904330000); these are three
-- more instances of it, found by auditing grants rather than migrations.
--
-- MEASURED ON PRODUCTION, 2026-09-17, by impersonating the roles in a
-- rolled-back transaction (`set local role anon` / a Test Company user's JWT):
--
--   * `purge_better_reports_overlap(uuid)` -- EXECUTE held by anon AND
--     authenticated. It DELETEs from `sales_by_day` for whatever company id it
--     is handed, with no membership check, and its argument DEFAULTED to
--     Baseballism. So an unauthenticated caller holding the anon key -- which
--     ships in `pages/config.js` and is public by design -- could delete
--     another tenant's Better Reports sales history. Confirmed callable as
--     `anon` against a company the caller has no relationship to.
--   * `backfill_company_entity_batch(text, uuid, int)` -- EXECUTE held by anon
--     AND authenticated. It STAMPS unclaimed (`company_entity_id is null`) rows
--     of `sales_by_day` / `inventory_on_hand` with any entity id the caller
--     names. That is a tenant-ASSIGNMENT primitive: any row that lands
--     unstamped is claimable by anyone. Confirmed callable as `anon` naming
--     Baseballism's entity id.
--   * `attach_stamp_company_entity_id_triggers()` -- EXECUTE held by anon AND
--     authenticated. It runs DDL (DROP/CREATE TRIGGER) across every table
--     carrying `company_entity_id`. Not a read path, but an unauthenticated
--     lock-storm, and it rewrites the very triggers that stamp tenancy.
--   * `refresh_demand_coverage_base_mv()` -- EXECUTE held by anon AND
--     authenticated: an unauthenticated 300-second matview refresh.
--
-- None of the four is called from the browser. Every real caller is a
-- service-role path (`scripts/shopify-sync.mjs`,
-- `scripts/sync-silo-inventory-sales.mjs`,
-- `scripts/backfill-company-entity-large-tables.mjs`, and the
-- `shopify-sync-run` edge function's admin client), so revoking the client
-- roles costs nothing operationally.
--
-- TWO LAYERS, DELIBERATELY
-- The REVOKE is the fix. The in-body `current_user` guard is the belt: the
-- whole reason these were reachable is that Postgres/Supabase hands out EXECUTE
-- by default, so a future `create or replace` of any of them silently restores
-- the grant and reopens the hole with no diff to review.
--
-- The guard reads `current_setting('role', true)`, NOT `current_user`. This is
-- the trap worth remembering: inside a SECURITY DEFINER function `current_user`
-- and `session_user` are both the function's OWNER (measured: `postgres`) no
-- matter who called it, so the obvious `current_user in ('anon',
-- 'authenticated')` guard is INERT -- it never fires, and reads in review like
-- a working control. The `role` GUC, which PostgREST sets per request with `SET
-- LOCAL ROLE`, does survive the definer boundary: measured `anon` for an
-- anonymous request, `authenticated` for a user JWT, `service_role` for a
-- service-key call. The first version of this migration had the inert guard and
-- a mutation test caught it -- the test re-grants EXECUTE to anon and
-- authenticated, calls the function as each, and fails unless both are refused.
--
-- `verify_v2_schema.sql` gets a third layer: an allowlist of anon-executable
-- SECURITY DEFINER functions that goes CRITICAL on anything new, so the next
-- instance of this class is caught by the daily drift check rather than by the
-- next audit.
--
-- SILENT BASEBALLISM FALLBACK
-- `admin_update_profile` and `approve_access_request` both resolved the company
-- to write a membership into as
-- `coalesce(public.active_company_id(), '3bd934c9-...'::uuid)` -- i.e. when the
-- acting admin has no active company, the user being approved was made a member
-- of BASEBALLISM. For a second tenant that is not a default, it is a
-- cross-tenant grant: a brand-new org's admin approving their own first
-- teammate, before anyone has been through the company picker, puts that
-- teammate in Baseballism. Both now fail closed. `active_company_id()` already
-- returns NULL rather than guessing, so the ambiguity was always visible here;
-- the coalesce is what threw it away.
--
-- Reversible: every change is a grant or a function body. Reverting is a
-- re-grant plus the previous definition, which is preserved in the migrations
-- named in each section below.
-- =============================================================================

-- ── 1. purge_better_reports_overlap ─────────────────────────────────────────
-- Previous definition: 20260626120000_purge_better_reports_overlap.sql.
-- Changes: the Baseballism default argument is GONE (a destructive function
-- should never have a default target -- a mistyped call becomes a call against
-- production's largest tenant), and the caller must be service-role.
--
-- This is a DROP + CREATE, not a CREATE OR REPLACE, because Postgres refuses to
-- remove a parameter default from an existing function ("cannot remove
-- parameter defaults from existing function") -- and removing that default is
-- half the point. The drop is safe: nothing in the database depends on this
-- function (no view, no trigger, no policy references it), and all three
-- callers reach it over PostgREST/RPC by name, passing the argument explicitly.
drop function if exists public.purge_better_reports_overlap(uuid);

create function public.purge_better_reports_overlap(
  p_company_entity_id uuid
)
returns table(deleted_rows bigint)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $function$
declare
  v_deleted bigint;
begin
  -- Belt to the REVOKE below; see the header.
  if coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
    raise exception 'purge_better_reports_overlap is service-role only'
      using errcode = '42501';
  end if;

  if p_company_entity_id is null then
    raise exception 'purge_better_reports_overlap requires an explicit company'
      using errcode = '22004';
  end if;

  delete from public.sales_by_day br
  where br.source = 'better_reports'
    and br.company_entity_id = p_company_entity_id
    and exists (
      select 1
      from public.sales_by_day api
      where api.source            = 'shopify_api'
        and api.company_entity_id = br.company_entity_id
        and api.location_tag      = br.location_tag
        and api.day_date          = br.day_date
    );

  get diagnostics v_deleted = row_count;
  return query select v_deleted;
end;
$function$;

revoke all on function public.purge_better_reports_overlap(uuid) from public;
revoke all on function public.purge_better_reports_overlap(uuid) from anon;
revoke all on function public.purge_better_reports_overlap(uuid) from authenticated;
grant execute on function public.purge_better_reports_overlap(uuid) to service_role;

-- ── 2. backfill_company_entity_batch ────────────────────────────────────────
-- Previous definition: the large-table backfill work
-- (.github/workflows/backfill-company-entity-large-tables.yml drives it).
-- Body is unchanged apart from the service-role guard.
create or replace function public.backfill_company_entity_batch(
  p_table text,
  p_entity_id uuid,
  p_batch_size integer default 10000
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  updated_count int;
begin
  -- This assigns TENANCY to unclaimed rows. It must never be reachable from a
  -- browser session; see the header.
  if coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
    raise exception 'backfill_company_entity_batch is service-role only'
      using errcode = '42501';
  end if;

  if p_entity_id is null then
    raise exception 'backfill_company_entity_batch requires an explicit company'
      using errcode = '22004';
  end if;

  -- Supabase default is 2min; inventory batches need more headroom.
  perform set_config('statement_timeout', '600000', true); -- 10 minutes (ms)

  if p_table = 'sales_by_day' then
    with batch as (
      select id
      from public.sales_by_day
      where company_entity_id is null
      limit p_batch_size
    )
    update public.sales_by_day as t
    set company_entity_id = p_entity_id
    from batch
    where t.id = batch.id;
    get diagnostics updated_count = row_count;

  elsif p_table = 'inventory_on_hand' then
    with batch as (
      select id
      from public.inventory_on_hand
      where company_entity_id is null
      limit p_batch_size
    )
    update public.inventory_on_hand as t
    set company_entity_id = p_entity_id
    from batch
    where t.id = batch.id;
    get diagnostics updated_count = row_count;

  else
    raise exception 'Unknown table: %', p_table;
  end if;

  return updated_count;
end;
$function$;

revoke all on function public.backfill_company_entity_batch(text, uuid, integer) from public;
revoke all on function public.backfill_company_entity_batch(text, uuid, integer) from anon;
revoke all on function public.backfill_company_entity_batch(text, uuid, integer) from authenticated;
grant execute on function public.backfill_company_entity_batch(text, uuid, integer) to service_role;

-- ── 3. attach_stamp_company_entity_id_triggers ──────────────────────────────
-- DDL helper. Never called from the app (no in-repo caller at all); it is run
-- by hand after adding a company-scoped table.
revoke all on function public.attach_stamp_company_entity_id_triggers() from public;
revoke all on function public.attach_stamp_company_entity_id_triggers() from anon;
revoke all on function public.attach_stamp_company_entity_id_triggers() from authenticated;
grant execute on function public.attach_stamp_company_entity_id_triggers() to service_role;

-- ── 4. refresh_demand_coverage_base_mv ──────────────────────────────────────
-- Called once at the end of the Shopify sync (service role). A 300s refresh
-- should not be an unauthenticated endpoint.
revoke all on function public.refresh_demand_coverage_base_mv() from public;
revoke all on function public.refresh_demand_coverage_base_mv() from anon;
revoke all on function public.refresh_demand_coverage_base_mv() from authenticated;
grant execute on function public.refresh_demand_coverage_base_mv() to service_role;

-- ── 5. admin_update_profile: fail closed instead of defaulting to Baseballism ─
-- Previous definition: 20260804200000_admin_update_profile_executive_role.sql.
-- ONE line changes (v_company_id). Everything else is carried over verbatim.
create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_name text default null,
  p_department text default null,
  p_role text default null,
  p_is_active boolean default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role_in text := lower(nullif(trim(coalesce(p_role, '')), ''));
  v_role app_role;
  v_membership_role text;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_has_other_org boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  if v_role_in is not null then
    case v_role_in
      when 'owner'     then v_role := 'owner';     v_membership_role := 'owner_admin';
      when 'admin'     then v_role := 'admin';     v_membership_role := 'admin';
      when 'executive' then v_role := 'executive'; v_membership_role := 'admin';
      when 'member'    then v_role := 'user';      v_membership_role := 'member';
      when 'viewer'    then v_role := 'user';      v_membership_role := 'viewer';
      when 'user'      then v_role := 'user';      v_membership_role := 'member';
      else raise exception 'unknown role %', p_role;
    end case;
  end if;

  -- WAS: coalesce(public.active_company_id(), '3bd934c9-...'::uuid).
  -- An admin whose own active company is unresolved has not told us which org
  -- this person is being added to, and the answer is not "Baseballism". The
  -- membership insert below is a grant of access to a tenant's data, so an
  -- ambiguous tenant has to stop the call, not pick one.
  v_company_id := public.active_company_id();
  if v_company_id is null then
    raise exception 'no active company: cannot resolve which organization this profile belongs to'
      using errcode = '22004';
  end if;

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = p_user_id and em.entity_id <> v_company_id
  ) into v_has_other_org;

  if v_has_other_org then
    update public.profiles
       set name = coalesce(p_name, name),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  else
    update public.profiles
       set name = coalesce(p_name, name),
           department = coalesce(p_department, department),
           role = coalesce(v_role, role),
           is_active = coalesce(p_is_active, is_active),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  end if;

  if not found then
    raise exception 'profile not found';
  end if;

  if v_final_active then
    if v_membership_role is not null then
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do update
        set role = excluded.role;
    else
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id,
              case v_final_role
                when 'owner' then 'owner_admin'
                when 'admin' then 'admin'
                when 'executive' then 'admin'
                else 'member'
              end)
      on conflict (entity_id, user_id) do nothing;
    end if;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

-- ── 6. approve_access_request: same fail-closed change ──────────────────────
-- Previous definition: 20260714190000_new_org_signup_flow.sql.
create or replace function public.approve_access_request(
  p_request_id uuid,
  p_department text default null,
  p_role text default null
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req public.access_requests%rowtype;
  v_dept text;
  v_role app_role;
  v_membership_role text;
  v_company_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select * into v_req
  from public.access_requests
  where id = p_request_id;

  if not found then
    raise exception 'request not found';
  end if;

  -- Cross-tenant guard: an admin can only approve requests aimed at their
  -- own active company (legacy rows with no company count as the caller's).
  if v_req.company_entity_id is not null
     and v_req.company_entity_id <> public.active_company_id() then
    raise exception 'not authorized';
  end if;

  if v_req.user_id is null then
    raise exception 'request missing user_id (user must authenticate once so we can capture auth.uid())';
  end if;

  v_dept := coalesce(nullif(trim(p_department), ''), v_req.department, 'ops');

  v_role := case lower(coalesce(nullif(trim(p_role), ''), v_req.requested_role, 'user'))
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  -- WAS: coalesce(v_req.company_entity_id, active_company_id(), '3bd934c9-...').
  -- The request's own company still wins where it has one -- that is the
  -- legitimate case, and the guard above has already proved it matches the
  -- approver. What is gone is the third rung: a legacy request with no company,
  -- approved by an admin with no active company, used to mint a Baseballism
  -- membership for someone nobody said was a Baseballism employee.
  v_company_id := coalesce(v_req.company_entity_id, public.active_company_id());
  if v_company_id is null then
    raise exception 'no active company: cannot resolve which organization to grant access to'
      using errcode = '22004';
  end if;

  insert into public.profiles (id, email, name, role, department, is_active, created_at, updated_at)
  values (v_req.user_id, v_req.email, v_req.full_name, v_role, v_dept, true, now(), now())
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(excluded.name, public.profiles.name),
        role = excluded.role,
        department = excluded.department,
        is_active = true,
        updated_at = now();

  v_membership_role := case v_role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_company_id, v_req.user_id, v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.access_requests
     set status = 'approved'
   where id = p_request_id;

  return json_build_object(
    'ok', true,
    'user_id', v_req.user_id,
    'role', v_role::text,
    'department', v_dept,
    'company_entity_id', v_company_id
  );
end;
$function$;

-- The profile-facing RPCs stay callable by logged-in admins; both gate on
-- is_admin() internally. Re-stating the grants keeps them explicit rather than
-- inherited from the schema default.
revoke all on function public.admin_update_profile(uuid, text, text, text, boolean, text) from public;
revoke all on function public.admin_update_profile(uuid, text, text, text, boolean, text) from anon;
grant execute on function public.admin_update_profile(uuid, text, text, text, boolean, text) to authenticated;
grant execute on function public.admin_update_profile(uuid, text, text, text, boolean, text) to service_role;

revoke all on function public.approve_access_request(uuid, text, text) from public;
revoke all on function public.approve_access_request(uuid, text, text) from anon;
grant execute on function public.approve_access_request(uuid, text, text) to authenticated;
grant execute on function public.approve_access_request(uuid, text, text) to service_role;
