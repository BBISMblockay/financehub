-- admin_update_profile: an 'admin' could make themselves an owner.
--
-- Found in the 2026-10-14 platform security audit (Critical 4), re-verified
-- against production 2026-10-19 before this was written.
--
-- WHAT WAS WRONG
-- The function is SECURITY DEFINER, EXECUTE to `authenticated`, and gated only
-- on is_admin() -- which passes for membership role 'admin' as well as
-- 'owner_admin'. It then maps p_role='owner' to membership 'owner_admin' and
-- ends with an upsert that carries `do update set role = excluded.role`.
-- Nothing checked who the target was, so:
--
--   select public.admin_update_profile(auth.uid(), null, null, 'owner');
--
-- promoted the CALLER to owner_admin. On production at the time of writing that
-- was reachable by 53 'admin' memberships across 40 distinct people. The same
-- gap let an 'admin' demote an existing owner, which is the same attack wearing
-- a different hat: strip the owner rather than join them.
--
-- The sibling set_workspace_member_role (20260920120000) already closes exactly
-- this -- "Only an owner_admin may hand out or take away owner_admin. An 'admin'
-- promoting themselves is the escalation this closes." -- so this migration
-- mirrors that function rather than inventing a second rule for the same
-- invariant. create_org_invite closes it too. admin_update_profile was the one
-- path that was missed.
--
-- WHY THE GUARD COMPARES AGAINST STORED STATE, AND NOT "WAS p_role SUPPLIED"
-- This is the part that breaks the UI if you get it wrong. v2/backend.html
-- builds its payload at :1160-1167 and sends EVERY field on EVERY save,
-- including p_role carrying the dialog's current value. So an admin editing an
-- owner's name sends p_role='owner' for somebody who is already owner_admin,
-- and an admin editing their own department sends their own existing role back.
-- A guard that fires on "p_role names owner" would refuse both of those -- a
-- rename would start failing with a privilege error. The guards below therefore
-- fire only when the membership role would actually CHANGE. A no-op re-send of
-- the role somebody already holds is allowed, exactly as it is today.
-- v2/settings-team.html:289 (setDepartment) sends p_role => null and so reaches
-- none of this.
--
-- WHY THE ADVISORY LOCK IS NOT OPTIONAL
-- 20260920120000 takes pg_advisory_xact_lock on
-- 'silo-workspace-membership|<company>' in BOTH set_workspace_member_role and
-- remove_workspace_member, and its comment is explicit that ONE key is shared
-- across the pair because the "at least one owner" invariant spans them: a
-- per-function key would serialise each against itself and leave "one owner
-- demoted while another is removed" wide open. Teaching a THIRD function to
-- change owner roles without taking that same key would reopen the race those
-- two closed -- two owners stepping down through different functions would both
-- count two owners, both pass, and the workspace would end with none, which
-- nothing in the product can undo. So this takes the same key, built the same
-- way. It is taken whenever p_role is supplied, before the current role is
-- read, because reading first and locking after is the check-then-act bug the
-- lock exists to prevent.
--
-- THE ONE OTHER DIFFERENCE, AND WHY IT IS SAFE
-- search_path goes from `public` to `public, pg_temp`. That is not cosmetic and
-- it is not a risk. Postgres searches pg_temp FIRST, ahead of pg_catalog, for
-- relation and type names whenever pg_temp is not listed explicitly -- so the
-- deployed function (proconfig `search_path=public`, read live 2026-10-19)
-- resolves unqualified names against a caller-controlled schema before the real
-- one. Naming pg_temp LAST is the standard fix and it strictly narrows what the
-- function can see: nothing in the body means to resolve anything from pg_temp,
-- every table reference is already schema-qualified, and the unqualified
-- `app_role` type stops being shadowable by a temp composite. platform_list_
-- accounts in 20261009120000 is already written this way, so this matches the
-- file this replaces rather than introducing a new convention.
--
-- NOT CHANGED HERE
-- Read live before this was written: the deployed body matches 20261009120000's
-- under whitespace normalisation (md5 ce4df51f50f8f4521f0a18266212a7f8 both
-- ways), so this replaces exactly what the repo says is deployed and overwrites
-- no hand-applied change.
--
-- The ordering of the existing authorization checks, their messages, and the
-- unreachable-but-harmless 22004 branch are all left exactly as they are. Apart
-- from the search_path above, the only behavioural difference is the refusals
-- added below. Deactivating a profile (p_is_active => false) is untouched, and
-- an admin can still deactivate an owner: that is a separate property and it is
-- filed in docs/ops/bugs.md rather than fixed here.
--
-- Callers, all three in the browser and all covered by the regression suite:
-- v2/backend.html:1169 (every field, every save), v2/backend.html:1184
-- (p_is_active => false alone, so p_role is null and the guards are not
-- reached) and v2/settings-team.html:289 (p_role => null, same). No SQL
-- function and no edge function calls it; redeem_platform_invite names it in a
-- comment only (checked against production's pg_proc, not just the repo).
--
-- OWNER AUTHORITY IS BOUND TO THE COMPANY BEING WRITTEN (review cycle 1, P1)
-- The first version of this migration asked `is_owner_admin_of_active_company`,
-- which re-resolves `profiles.active_company_id` every time it is called. The
-- lock, the current-role read and the upsert all use the captured
-- `v_company_id`, so those two reads could disagree, and a PL/pgSQL function is
-- VOLATILE: each query inside it takes a fresh snapshot, so a value committed
-- by another transaction mid-call is visible to the next query.
--
-- That is a real escalation, not a theoretical one. A caller who is `admin` in
-- company A and `owner_admin` in company B calls this with active company A, so
-- v_company_id = A. `set_active_company()` takes no membership lock, so a second
-- request can commit a switch to B while this call is still waiting on A's
-- advisory lock -- and an `admin` of A can create that wait themselves, since
-- every save from the users panel takes the same key. The call then resumes,
-- asks "am I an owner of my active company", gets B, and grants `owner_admin`
-- in A. Found by the independent review; credited there.
--
-- So authority is now asked about ONE company, explicitly, under the lock:
-- `is_owner_admin_of_company(v_company_id)`. Nothing mutable is re-read, so the
-- window does not exist rather than being narrow.
--
-- WHY THE TWO WORKSPACE-SETTINGS FUNCTIONS ARE ALSO REPLACED
-- set_workspace_member_role and remove_workspace_member have the identical
-- shape -- capture `v_company`, lock on it, then ask the active-company helper
-- -- and both are reachable by any membership `admin` through `is_admin()`.
-- Fixing only this function would leave the same escalation open one RPC over,
-- so an attacker would simply call Workspace Settings' RPC instead and this
-- migration would protect nothing. They are in scope because the PR's outcome
-- does not hold without them, not to widen it. Their bodies are otherwise
-- untouched: both were produced from 20260920120000 by substituting that one
-- call, and the substitution was asserted reversible (reversing it reproduces
-- the original text exactly).
--
-- Idempotent: create or replace. No table, no grant and no policy changes --
-- `create or replace` keeps the existing EXECUTE grants, which is what we want:
-- the function should stay callable by `authenticated`, it should just refuse
-- to escalate.

-- Owner authority over ONE named company. The active-company helper stays as it
-- is for its other callers; it is simply the wrong question for a function that
-- has already captured which company it is writing to.
create or replace function public.is_owner_admin_of_company(p_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = auth.uid()
      and em.entity_id = p_entity_id
      and em.role = 'owner_admin'
  );
$function$;

revoke execute on function public.is_owner_admin_of_company(uuid) from public;
revoke execute on function public.is_owner_admin_of_company(uuid) from anon;
grant  execute on function public.is_owner_admin_of_company(uuid) to authenticated;

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_name text default null,
  p_department text default null,
  p_role text default null,
  p_is_active boolean default null,
  p_notes text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role_in text := lower(nullif(trim(coalesce(p_role, '')), ''));
  v_role app_role;
  v_membership_role text;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_has_other_org boolean;
  v_current_membership_role text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- Only somebody who already belongs to the caller's active company. Adding
  -- a person to a company is an invitation (create_org_invite ->
  -- accept_org_invite), never a side effect of editing a profile. A NULL
  -- active company matches nothing and is refused here too.
  if not exists (select 1 from public.entity_memberships em
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

  -- ── Owner escalation guards ───────────────────────────────────────────────
  -- Only reached when the caller actually asked for a role (see the header on
  -- why "asked for a role" is not the same as "asked for a CHANGE of role").
  if v_membership_role is not null then
    -- Shared with set_workspace_member_role and remove_workspace_member. One
    -- key per company, not per function: the owner-count invariant spans all
    -- three. Taken before the current role is read.
    perform pg_advisory_xact_lock(
      hashtextextended('silo-workspace-membership|' || v_company_id::text, 0));

    select em.role into v_current_membership_role
      from public.entity_memberships em
     where em.entity_id = v_company_id and em.user_id = p_user_id
     for update;

    if v_membership_role is distinct from v_current_membership_role then
      -- Granting owner. The self-promotion this migration exists to stop is
      -- just the case where p_user_id = auth.uid(), and it needs no separate
      -- branch: an admin may not hand owner to anyone, themselves included.
      if v_membership_role = 'owner_admin'
         and not public.is_owner_admin_of_company(v_company_id) then
        raise exception 'only an owner can grant owner access';
      end if;

      -- Taking owner away. Same authority, and the workspace keeps an owner.
      if v_current_membership_role = 'owner_admin' then
        if not public.is_owner_admin_of_company(v_company_id) then
          raise exception 'only an owner can change another owner';
        end if;
        if (select count(*) from public.entity_memberships em
             where em.entity_id = v_company_id and em.role = 'owner_admin') <= 1 then
          raise exception 'this workspace must keep at least one owner';
        end if;
      end if;
    end if;
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


-- ── The two siblings, same defect, same one-expression fix ───────────────────
-- Reproduced from 20260920120000_workspace_settings_admin.sql with the
-- active-company helper call replaced by is_owner_admin_of_company(v_company)
-- and NOTHING else changed. `v_company` is each function's own captured
-- company, the same value its advisory lock and its writes already use.

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
  if (v_role = 'owner_admin') and not public.is_owner_admin_of_company(v_company) then
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
    if not public.is_owner_admin_of_company(v_company) then
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
    if not public.is_owner_admin_of_company(v_company) then
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
