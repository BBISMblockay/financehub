-- Per-company effective roles.
--
-- profiles.role is global, but a user can belong to multiple companies with
-- different roles (entity_memberships.role is already per-company). Before
-- this migration every permission gate read the global profile role, so
-- accepting an invite into a second org overwrote the caller's role
-- everywhere — e.g. joining Test Company as 'user' silently demoted a
-- Baseballism admin to read-only in Baseballism.
--
-- Rule now: if the caller has a membership row for their ACTIVE company,
-- gates judge by that membership role (owner_admin | admin | member |
-- viewer); the profile-level 'executive' role is preserved as an extra pass
-- wherever executive passed before. If no membership exists (legacy
-- accounts), gates fall back to the old profile-role logic unchanged.
-- profiles.department stays global (it drives nav + finance perms and only
-- exists on the profile).
--
-- Also:
-- - accept_org_invite / admin_update_profile no longer overwrite the global
--   profile role/department for users who already belong to another company
--   — the membership row carries the org role instead
-- - payment_requests_internal_update predated company isolation and had no
--   company_entity_id scope (any admin/finance user of any company passed
--   its USING clause) — now company-scoped
-- - payroll_* policies' inline profile-role checks made membership-aware

-- ── 1. Gate functions: membership role first, profile fallback ─

-- Caller's membership role in their active company (null = no membership).
CREATE OR REPLACE FUNCTION public.active_membership_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select em.role
  from public.entity_memberships em
  join public.profiles p on p.id = em.user_id
  where em.user_id = auth.uid()
    and em.entity_id = p.active_company_id;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','admin','executive')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_admin_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_owner_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin')
            else p.role::text in ('owner','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_exec_or_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role = 'owner_admin' or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','executive')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.reviews_can_manage()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in ('owner','executive','admin')
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.po_builder_can_write()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(p.role::text) in (
              'owner','admin','finance','exec','executive',
              'buyer','purchasing','operations'
            )
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.po_costing_can_write()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role in ('owner_admin','admin') or lower(p.role::text) = 'executive'
            else lower(coalesce(p.role::text, 'user')) in (
              'owner','admin','finance','exec','executive','buyer','purchasing','operations'
            )
          end
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_payment_requests()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role in ('owner_admin','admin')
             else p.role::text = 'admin'
        end
        or p.department in ('finance','admin','exec')
      )
  );
$function$;

-- ── 2. Policies with inline profile-role checks ───────────────

DROP POLICY IF EXISTS "payment_requests_active_select" ON public.payment_requests;
CREATE POLICY "payment_requests_active_select" ON public.payment_requests
  FOR SELECT USING (
    company_entity_id = active_company_id() AND (
      created_by = auth.uid() OR
      current_user_can_manage_payment_requests() OR
      is_admin_user()
    )
  );

-- Was un-scoped (predates company isolation): any admin/finance user of ANY
-- company passed its USING clause. Now company-scoped + membership-aware.
DROP POLICY IF EXISTS "payment_requests_internal_update" ON public.payment_requests;
CREATE POLICY "payment_requests_internal_update" ON public.payment_requests
  FOR UPDATE
  USING      (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests())
  WITH CHECK (company_entity_id = active_company_id() AND current_user_can_manage_payment_requests());

DROP POLICY IF EXISTS "payroll_import_batches_active_all" ON public.payroll_import_batches;
CREATE POLICY "payroll_import_batches_active_all" ON public.payroll_import_batches
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

DROP POLICY IF EXISTS "payroll_register_lines_active_all" ON public.payroll_register_lines;
CREATE POLICY "payroll_register_lines_active_all" ON public.payroll_register_lines
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

DROP POLICY IF EXISTS "payroll_time_lines_active_all" ON public.payroll_time_lines;
CREATE POLICY "payroll_time_lines_active_all" ON public.payroll_time_lines
  FOR ALL
  USING      (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')))
  WITH CHECK (company_entity_id = active_company_id() AND (is_admin_user() OR EXISTS (
                SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active AND p.department = 'finance')));

-- ── 3. Stop invite/role grants from bleeding across orgs ──────

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite public.org_invites%rowtype;
  v_profile_email text;
  v_role app_role;
  v_membership_role text;
  v_org_title text;
  v_has_other_org boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.org_invites
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and status = 'pending';

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  if v_invite.expires_at < now() then
    update public.org_invites set status = 'expired' where id = v_invite.id;
    raise exception 'invite has expired — ask your admin for a new one';
  end if;

  select lower(email) into v_profile_email from public.profiles where id = auth.uid();
  if v_profile_email is null then
    raise exception 'profile not found';
  end if;
  if v_profile_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  v_role := case v_invite.role
              when 'owner' then 'owner'::app_role
              when 'admin' then 'admin'::app_role
              else 'user'::app_role
            end;

  v_membership_role := case v_invite.role
                          when 'owner' then 'owner_admin'
                          when 'admin' then 'admin'
                          else 'member'
                        end;

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = auth.uid() and em.entity_id <> v_invite.entity_id
  ) into v_has_other_org;

  if v_has_other_org then
    -- Already belongs elsewhere: the membership row carries this org's role;
    -- leave the global profile role/department alone.
    update public.profiles
       set is_active = true,
           active_company_id = coalesce(active_company_id, v_invite.entity_id),
           updated_at = now()
     where id = auth.uid();
  else
    update public.profiles
       set role = v_role,
           department = v_invite.department,
           is_active = true,
           active_company_id = coalesce(active_company_id, v_invite.entity_id),
           updated_at = now()
     where id = auth.uid();
  end if;

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_invite.entity_id, auth.uid(), v_membership_role)
  on conflict (entity_id, user_id) do update
    set role = excluded.role;

  update public.org_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now()
   where id = v_invite.id;

  select title into v_org_title from public.entities where id = v_invite.entity_id;

  return json_build_object(
    'ok', true,
    'entity_id', v_invite.entity_id,
    'org_title', v_org_title,
    'role', v_role::text,
    'department', v_invite.department
  );
end;
$function$;

ALTER FUNCTION public.accept_org_invite(text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.admin_update_profile(p_user_id uuid, p_name text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role app_role;
  v_final_role app_role;
  v_final_active boolean;
  v_company_id uuid;
  v_membership_role text;
  v_has_other_org boolean;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- Cross-tenant guard: the target must belong to the caller's active
  -- company, or be unclaimed (no membership anywhere).
  if exists (select 1 from public.entity_memberships em where em.user_id = p_user_id)
     and not exists (select 1 from public.entity_memberships em
                     where em.user_id = p_user_id and em.entity_id = public.active_company_id()) then
    raise exception 'not authorized';
  end if;

  v_role := case
    when p_role is null or trim(p_role) = '' then null
    when lower(p_role) = 'owner' then 'owner'::app_role
    when lower(p_role) = 'admin' then 'admin'::app_role
    else 'user'::app_role
  end;

  v_company_id := coalesce(public.active_company_id(), '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid);

  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = p_user_id and em.entity_id <> v_company_id
  ) into v_has_other_org;

  if v_has_other_org then
    -- Multi-org target: the role change applies to THIS org's membership
    -- only; don't rewrite their global profile role/department.
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
    if v_role is not null then
      -- Explicit role change: apply it to this org's membership.
      v_membership_role := case v_role
                              when 'owner' then 'owner_admin'
                              when 'admin' then 'admin'
                              else 'member'
                            end;
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do update
        set role = excluded.role;
    else
      -- No role change: only ensure a membership exists (seeded from the
      -- profile role); never rewrite an existing membership's role.
      v_membership_role := case v_final_role
                              when 'owner' then 'owner_admin'
                              when 'admin' then 'admin'
                              else 'member'
                            end;
      insert into public.entity_memberships (entity_id, user_id, role)
      values (v_company_id, p_user_id, v_membership_role)
      on conflict (entity_id, user_id) do nothing;
    end if;

    update public.profiles
       set active_company_id = v_company_id
     where id = p_user_id
       and active_company_id is null;
  end if;
end;
$function$;

ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text) SET search_path = public;

-- ── 4. Legacy data alignment ──────────────────────────────────
-- Pre-multi-tenant founding owners were seeded with plain 'admin'
-- memberships while their profile role said 'owner'. Under membership-first
-- gates they'd lose owner-level access (is_exec_or_owner), so lift those
-- memberships to owner_admin.

update public.entity_memberships em
   set role = 'owner_admin'
  from public.profiles p
 where p.id = em.user_id
   and p.role::text = 'owner'
   and em.role = 'admin';

-- ── 5. Grants ─────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.active_membership_role() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.active_membership_role() TO authenticated;
