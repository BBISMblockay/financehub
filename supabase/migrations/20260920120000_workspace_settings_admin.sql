-- =============================================================================
-- Workspace Settings: membership administration, and the platform-admin read.
--
-- Three functions, each closing a gap that Workspace Settings' Team tab and the
-- Silo Admin area ran into. No new tables, no new role vocabulary, no change to
-- any existing gate.
--
-- 1. set_workspace_member_role(user, role)
--
--    Changing somebody's role today means admin_update_profile(), which writes
--    the GLOBAL profiles.role as well as the membership row. profiles.role is
--    not per-company, and several gates read it on its own --
--    can_manage_journal_entries() admits `p.department in ('finance','exec')`
--    and falls back to p.role with no reference to which company you are in --
--    so promoting a contractor to admin of company B silently promoted them
--    inside company A as well. This is the same hazard 20260918120000 fixed for
--    company founding, and it is fixed here the same way: the membership row is
--    always written, and the global profile is touched ONLY when the target
--    belongs to no other organization.
--
--    It also refuses to remove the last owner_admin. A workspace with no
--    owner_admin cannot edit company_settings (is_owner_admin_of_active_company)
--    or manage its own subscription (stripe-billing), and nothing in the product
--    can put one back -- only a service-role write can.
--
-- 2. remove_workspace_member(user)
--
--    There was no way to remove somebody from ONE workspace. The nearest thing,
--    admin_update_profile(p_is_active => false), sets a GLOBAL flag: it locks
--    the person out of every company they belong to, which is the wrong act
--    when a contractor's engagement with one client ends. This deletes the
--    membership for the caller's active company and nothing else.
--
--    Safeguards, all refusals rather than silent no-ops: never yourself (an
--    admin removing their own last membership strands their session with an
--    active_company_id they are no longer a member of), never the last
--    owner_admin, and an owner_admin may only be removed by another
--    owner_admin. If the removal leaves the person with no company at all their
--    profile is deactivated, because a profile with no membership is otherwise
--    an "unclaimed" profile that any admin of any company may adopt.
--
-- 4. platform_list_companies()
--
--    The Silo Admin area needs to see every tenant, which no ordinary read can
--    do: every table worth showing is scoped to active_company_id(). SECURITY
--    DEFINER, gated by is_platform_admin() -- deliberately NOT is_admin_user()
--    and not "any owner_admin", the same separation platform_admins already
--    documents. It returns operational facts only (counts, plan status,
--    freshness), never another tenant's business data.
--
-- Idempotent: create-or-replace only.
-- =============================================================================

-- ── 1. Workspace role ───────────────────────────────────────────────────────

create or replace function public.set_workspace_member_role(p_user_id uuid, p_role text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_role text;
  v_current text;
  v_other_orgs boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;


  -- Serialise every owner-count decision for this company, across BOTH
  -- functions. `for update` below locks only the TARGET membership row, while
  -- the last-owner check counts the OTHER rows unlocked -- check-then-act
  -- across two different rows. Self-demotion is allowed on purpose, so two
  -- owners can each step back with no overlapping row lock at all: both count
  -- two owners, both pass, both commit, and the workspace has none. Nothing in
  -- the product can put an owner back, so that state is permanent.
  --
  -- ONE key shared by set_workspace_member_role and remove_workspace_member,
  -- not one per function: the invariant spans the pair, and a per-function key
  -- would serialise each against itself while leaving "one owner demoted while
  -- another is removed" wide open. Same mechanism and same reasoning as the
  -- per-company currency lock in 20260918120000.
  --
  -- Measured, not argued: scripts/tests/workspace-settings-concurrency.test.mjs
  -- drives two real connections and leaves the workspace with ZERO owners
  -- without this line (WS_RACE_MUTATION=owner-count-unlocked).
  perform pg_advisory_xact_lock(
    hashtextextended('silo-workspace-membership|' || v_company::text, 0));

  v_role := lower(trim(coalesce(p_role, '')));
  if v_role not in ('owner_admin', 'admin', 'member', 'viewer') then
    raise exception 'unknown workspace role: %', coalesce(p_role, '(null)');
  end if;

  -- Only an owner_admin may hand out or take away owner_admin. An 'admin'
  -- promoting themselves is the escalation this closes.
  if (v_role = 'owner_admin') and not public.is_owner_admin_of_active_company() then
    raise exception 'only an owner can grant owner access';
  end if;

  select em.role into v_current
    from public.entity_memberships em
   where em.entity_id = v_company and em.user_id = p_user_id
   for update;

  if v_current is null then
    raise exception 'not a member of this workspace';
  end if;

  if v_current = 'owner_admin' and v_role <> 'owner_admin' then
    if not public.is_owner_admin_of_active_company() then
      raise exception 'only an owner can change another owner';
    end if;
    if (select count(*) from public.entity_memberships em
         where em.entity_id = v_company and em.role = 'owner_admin') <= 1 then
      raise exception 'this workspace must keep at least one owner';
    end if;
  end if;

  update public.entity_memberships
     set role = v_role
   where entity_id = v_company and user_id = p_user_id;

  -- The global profile is another company's business unless this is the only
  -- company the person belongs to. Same rule accept_org_invite and
  -- redeem_platform_invite follow, and for the same reason.
  select exists (select 1 from public.entity_memberships em
                  where em.user_id = p_user_id and em.entity_id <> v_company)
    into v_other_orgs;

  if not v_other_orgs then
    update public.profiles
       set role = case v_role
                    when 'owner_admin' then 'owner'::app_role
                    when 'admin' then 'admin'::app_role
                    else 'user'::app_role
                  end,
           updated_at = now()
     where id = p_user_id;
  end if;

  return json_build_object(
    'ok', true,
    'user_id', p_user_id,
    'role', v_role,
    'global_role_updated', not v_other_orgs
  );
end;
$$;

comment on function public.set_workspace_member_role(uuid, text) is
  'Set a member''s role for the CALLER''S ACTIVE company. Writes entity_memberships always; writes the global profiles.role only when the target belongs to no other organization, because profiles.role is read by gates that never consult which company you are in. Refuses to leave the workspace without an owner_admin.';

revoke all on function public.set_workspace_member_role(uuid, text) from public, anon;
grant execute on function public.set_workspace_member_role(uuid, text) to authenticated;


-- ── 2. Removing a member from one workspace ─────────────────────────────────

create or replace function public.remove_workspace_member(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_role text;
  v_remaining uuid;
  v_deactivated boolean := false;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;


  -- The same shared per-company lock the role change takes; see the comment
  -- there. The invariant spans both functions, so they must share one key.
  perform pg_advisory_xact_lock(
    hashtextextended('silo-workspace-membership|' || v_company::text, 0));

  if p_user_id = auth.uid() then
    raise exception 'you cannot remove yourself from this workspace';
  end if;

  select em.role into v_role
    from public.entity_memberships em
   where em.entity_id = v_company and em.user_id = p_user_id
   for update;

  if v_role is null then
    raise exception 'not a member of this workspace';
  end if;

  if v_role = 'owner_admin' then
    if not public.is_owner_admin_of_active_company() then
      raise exception 'only an owner can remove another owner';
    end if;
    if (select count(*) from public.entity_memberships em
         where em.entity_id = v_company and em.role = 'owner_admin') <= 1 then
      raise exception 'this workspace must keep at least one owner';
    end if;
  end if;

  delete from public.entity_memberships
   where entity_id = v_company and user_id = p_user_id;

  -- Any pending invite for this person is spent: leaving it live would let
  -- them walk straight back in through a link already in their inbox.
  update public.org_invites
     set status = 'revoked'
   where entity_id = v_company
     and status = 'pending'
     and lower(email) = (select lower(pr.email) from public.profiles pr where pr.id = p_user_id);

  -- Their session points at a company they are no longer in. Move them to
  -- another membership if they have one; otherwise clear it and deactivate --
  -- a profile with no membership anywhere is "unclaimed" and adoptable by any
  -- admin of any company, which is not what removing somebody should mean.
  select em.entity_id into v_remaining
    from public.entity_memberships em
   where em.user_id = p_user_id
   order by em.entity_id
   limit 1;

  if v_remaining is null then
    v_deactivated := true;
    update public.profiles
       set active_company_id = null, is_active = false, updated_at = now()
     where id = p_user_id;
  else
    update public.profiles
       set active_company_id = v_remaining, updated_at = now()
     where id = p_user_id and active_company_id = v_company;
  end if;

  return json_build_object(
    'ok', true,
    'user_id', p_user_id,
    'removed_role', v_role,
    'deactivated', v_deactivated
  );
end;
$$;

comment on function public.remove_workspace_member(uuid) is
  'Remove a member from the CALLER''S ACTIVE company only -- not the global is_active flag, which locks a person out of every company they belong to. Revokes their pending invite here, repoints or clears active_company_id, and deactivates only a profile left with no membership anywhere. Refuses self-removal and refuses to leave the workspace without an owner_admin.';

revoke all on function public.remove_workspace_member(uuid) from public, anon;
grant execute on function public.remove_workspace_member(uuid) to authenticated;


-- ── 3. Renaming the workspace ───────────────────────────────────────────────
-- `entities` carries ONE policy, entities_select_member, and no UPDATE policy
-- at all, so "rename your company" was not possible from the product. The
-- obvious fix -- an UPDATE policy for owner_admins -- is the wrong one: RLS
-- cannot scope to columns, so it would also hand the browser `entity_key`
-- (the tenant's stable key, which resolveNavProfile and several syncs read),
-- `meta` (which holds nav_profile) and `entity_type`. A definer function that
-- writes one column is column-scoped by construction.

create or replace function public.set_workspace_company_name(p_title text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_title text;
begin
  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;
  if not public.is_owner_admin_of_active_company() then
    raise exception 'only an owner can rename this workspace';
  end if;

  v_title := nullif(trim(coalesce(p_title, '')), '');
  if v_title is null then
    raise exception 'a company name is required';
  end if;
  if length(v_title) > 120 then
    raise exception 'company name is too long';
  end if;

  update public.entities
     set title = v_title, updated_at = now()
   where id = v_company and entity_type = 'company';

  if not found then
    raise exception 'company not found';
  end if;

  return json_build_object('ok', true, 'title', v_title);
end;
$$;

comment on function public.set_workspace_company_name(text) is
  'Rename the caller''s active company. A definer function rather than an UPDATE policy on entities, because RLS cannot scope to columns and an owner_admin has no business writing entity_key, entity_type or meta (which holds nav_profile) from a browser.';

revoke all on function public.set_workspace_company_name(text) from public, anon;
grant execute on function public.set_workspace_company_name(text) to authenticated;


-- ── 4. Platform-admin company list ──────────────────────────────────────────

create or replace function public.platform_list_companies()
returns table (
  entity_id uuid,
  title text,
  entity_key text,
  created_at timestamptz,
  member_count bigint,
  active_member_count bigint,
  owner_admin_count bigint,
  business_timezone text,
  default_currency text,
  subscription_status text,
  plan_key text,
  last_sync_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select e.id,
         e.title,
         e.entity_key,
         e.created_at,
         (select count(*) from public.entity_memberships em where em.entity_id = e.id),
         (select count(*) from public.entity_memberships em
            join public.profiles pr on pr.id = em.user_id
           where em.entity_id = e.id and coalesce(pr.is_active, true)),
         (select count(*) from public.entity_memberships em
           where em.entity_id = e.id and em.role = 'owner_admin'),
         cs.business_timezone,
         cs.default_currency,
         bs.status,
         bs.plan_key,
         -- finished_at, not created_at: a queued or crashed job is not a sync.
         (select max(sj.finished_at) from public.sync_jobs sj
           where sj.company_entity_id = e.id and sj.status = 'success')
    from public.entities e
    left join public.company_settings cs on cs.company_entity_id = e.id
    left join public.billing_subscriptions bs on bs.company_entity_id = e.id
   where e.entity_type = 'company'
   order by e.created_at desc nulls last, e.title asc;
end;
$$;

comment on function public.platform_list_companies() is
  'Every tenant, for the Silo Admin area. is_platform_admin() only -- founding and administering tenants is a platform act, and 28 of 29 Baseballism profiles are membership admin, so is_admin_user() would be no gate at all. Returns operational facts (counts, declared settings, plan status, sync freshness) and no tenant business data.';

revoke all on function public.platform_list_companies() from public, anon;
grant execute on function public.platform_list_companies() to authenticated;
