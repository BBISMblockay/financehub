-- Workspace admins must not suspend a global account through profile editing.
-- Copy of the live 20261019180000 RPC with only an activity-change guard and
-- removal of BOTH is_active assignments. Null and unchanged status are accepted
-- for older clients; stale/different status fails atomically (SQLSTATE 42501).
-- No platform-admin bypass: platform_list_accounts/companies are read-only;
-- a future platform suspension policy is a separate decision. Existing Team
-- removal, owner/finance rules, role vocabulary, ACLs and notes behavior stay.
-- No production data writes. Apply separately with Blake's approval, then run
-- verify_v2_schema.sql. CREATE OR REPLACE preserves the existing function ACL.

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
  v_current_active boolean;
  v_company_id uuid;
  v_has_other_org boolean;
  v_current_membership_role text;
  v_current_department text;
  v_current_global_role text;
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

  -- ── Finance-authority guards ──────────────────────────────────────────────
  -- Blake's rule, 2026-10-19: "only owner and exec can make admin have
  -- finance". Two columns carry that authority and both are written by this
  -- function, neither of them through a membership change:
  --
  --   profiles.department in ('finance','exec')  -> can_manage_journal_entries()
  --   profiles.role = 'executive'                -> is_exec_or_owner()
  --
  -- can_manage_journal_entries() admits `p.department in ('finance','exec')` on
  -- its own, with no role of any kind, and is_exec_or_owner() admits
  -- `lower(p.role::text) = 'executive'` the same way -- 27 functions and 80+
  -- RLS policies across money and people hang off that second one. So an
  -- 'admin' could hand either to themselves or to anyone else through the
  -- users panel, and the owner guards above would never see it, because
  -- 'admin' and 'executive' both map to membership 'admin' and nothing about
  -- owner_admin changes.
  --
  -- create_org_invite already refuses exactly this on the invite path
  -- (20261008120000: "only an owner can invite into the % department", for
  -- 'finance', 'exec' and 'admin'), so this is the same rule on the other path
  -- rather than a new one. Two deliberate differences, both stated so the
  -- asymmetry is on purpose and not an oversight: the authority here is
  -- owner-OR-executive, because that is the rule as given, while the invite
  -- path is owner-only; and the department set is copied from that function
  -- verbatim, which is a superset of what can_manage_journal_entries() reads,
  -- so there is no third value to miss.
  --
  -- Only in the branch that actually writes those columns. For somebody who
  -- belongs to another company too, department and role are not written at all
  -- (see the two updates below), so there is nothing to escalate and refusing
  -- would only break saves.
  if not v_has_other_org then
    -- `for update` on the row being written, so the comparison cannot be made
    -- against a department another transaction is in the middle of changing.
    -- The lock order (advisory key, then entity_memberships, then profiles)
    -- matches set_workspace_member_role and remove_workspace_member.
    select lower(coalesce(pr.department, '')), lower(coalesce(pr.role::text, ''))
      into v_current_department, v_current_global_role
      from public.profiles pr
     where pr.id = p_user_id
     for update;

    -- Granting it, not re-sending it. Same reasoning as the owner guards: the
    -- users panel posts every field on every save, so an admin editing the
    -- name of somebody who is already in finance re-sends 'finance', and a
    -- guard keyed on "p_department names finance" would refuse that. On
    -- production when this was written, 20 of 55 profiles are already finance
    -- or exec, and every one of their saves has to keep working.
    -- Three clauses, and the middle two are different questions. "Is this a
    -- change at all" keeps a re-send allowed. "Do they already hold finance
    -- authority" is asked against ('finance','exec') ONLY -- the set
    -- can_manage_journal_entries() actually admits -- and NOT against the
    -- refused set, which also carries 'admin' from create_org_invite. Asking
    -- it against the refused set was the first version of this guard and it
    -- left a stepping stone: somebody in the 'admin' department, which grants
    -- nothing, would have counted as already having authority, and a plain
    -- admin could have moved them on to 'finance'. Found re-reading the diff.
    if lower(trim(coalesce(p_department, ''))) in ('finance', 'exec', 'admin')
       and lower(trim(coalesce(p_department, ''))) <> coalesce(v_current_department, '')
       and coalesce(v_current_department, '') not in ('finance', 'exec')
       and not public.is_exec_or_owner_of_company(v_company_id) then
      raise exception 'only an owner or executive can grant the % department',
        lower(trim(p_department));
    end if;

    -- The global 'executive' role, which is the same escalation wearing the
    -- role column instead of the department column.
    if v_role::text = 'executive'
       and coalesce(v_current_global_role, '') <> 'executive'
       and not public.is_exec_or_owner_of_company(v_company_id) then
      raise exception 'only an owner or executive can grant executive access';
    end if;
  end if;

  -- Compatibility input only: workspace editing never writes global status.
  -- Lock after the membership advisory/row locks, matching the existing order.
  -- Compare against the current row, not a status read before a concurrent save.
  select pr.is_active into v_current_active
    from public.profiles pr where pr.id = p_user_id for update;
  if p_is_active is not null and p_is_active is distinct from v_current_active then
    raise exception 'account status cannot be changed through workspace profile editing; use Workspace settings > Team to remove workspace access'
      using errcode = '42501';
  end if;

  if v_has_other_org then
    update public.profiles
       set name = coalesce(p_name, name),
           updated_at = now()
     where id = p_user_id
     returning role, is_active into v_final_role, v_final_active;
  else
    update public.profiles
       set name = coalesce(p_name, name),
           department = coalesce(p_department, department),
           role = coalesce(v_role, role),
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
