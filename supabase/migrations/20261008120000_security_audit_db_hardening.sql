-- ============================================================
-- 20261008120000_security_audit_db_hardening.sql
--
-- Database half of the 2026-10-08 security audit. Idempotent; safe to re-run.
--
-- 1. create_org_invite: an invite could grant more than its sender holds.
--    The gate was is_admin(), which passes for every membership `admin`, and
--    the function accepted p_role = 'owner' and any free-text department.
--    accept_org_invite / org-invite-redeem then wrote membership `owner_admin`,
--    global profiles.role = 'owner', and department = 'finance' / 'exec' /
--    'admin' -- the department alone satisfies can_manage_journal_entries(),
--    current_user_can_manage_comp_requests() and the payment-request gate. So
--    any admin could mint, for a second account they control, the money and
--    people authority CLAUDE.md says must never widen to is_admin_user().
--
--    Now: inviting an OWNER, or into a privileged department, needs the
--    sender to be an owner of the active company (membership owner_admin, or
--    -- for a legacy profile with no membership there -- global role owner,
--    the same fallback every other gate uses). Everything else is unchanged:
--    admins still invite users and admins into ops / logistics / marketing /
--    retail. v2/settings-team.html already disables "Owner" for non-owners
--    and now disables the privileged departments the same way.
--
-- 2. PO / costing / Launch Workbench permissive policies. 20260521110000,
--    20260521120000, 20260602140000 and 20260603140000 created
--    `using (true)` policies (cross-tenant read; the PO write policies had no
--    company predicate either). Production no longer has them (checked
--    2026-10-08 via pg_policy: only the *_active_* policies remain), but no
--    migration drops them, so a rebuild from migrations -- or a re-run of
--    apply_all_post_merge.sql, which includes those files -- would restore
--    them, and permissive policies OR together. Dropping them here, AFTER
--    those includes, makes the repo say what production says.
--
-- 3. generate_next_po_name(uuid) is executable by anon in production (it was
--    never revoked from PUBLIC). It is SECURITY INVOKER, so RLS bounds it, but
--    it writes po_sequences and nothing anonymous calls it. The PO builder
--    calls it signed in, so `authenticated` keeps EXECUTE.
-- ============================================================

-- ── 1. create_org_invite ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_org_invite(p_email text, p_role text DEFAULT 'user', p_department text DEFAULT 'ops')
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company uuid;
  v_email text;
  v_role text;
  v_department text;
  v_sender_is_owner boolean;
  v_token text;
  v_invite public.org_invites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no active company';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required';
  end if;

  v_role := case lower(coalesce(nullif(trim(p_role), ''), 'user'))
              when 'owner' then 'owner'
              when 'admin' then 'admin'
              else 'user'
            end;

  v_department := coalesce(nullif(trim(p_department), ''), 'ops');

  -- Owner of the ACTIVE company: membership owner_admin there, or, only when
  -- the sender has no membership in it, the legacy global owner role.
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = v_company
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
      and case when em.role is not null
            then em.role = 'owner_admin'
            else p.role::text = 'owner'
          end
  ) into v_sender_is_owner;

  if v_role = 'owner' and not v_sender_is_owner then
    raise exception 'only an owner can invite another owner';
  end if;

  -- The departments the money / people gates admit on. Compared normalised so
  -- 'Finance ' cannot slip past here and still be stored.
  if lower(v_department) in ('finance', 'exec', 'admin') and not v_sender_is_owner then
    raise exception 'only an owner can invite into the % department', lower(v_department);
  end if;

  if exists (
    select 1
    from public.entity_memberships em
    join public.profiles pr on pr.id = em.user_id
    where em.entity_id = v_company and lower(pr.email) = v_email
  ) then
    raise exception 'already a member of this organization';
  end if;

  update public.org_invites
     set status = 'revoked'
   where entity_id = v_company and lower(email) = v_email and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.org_invites (entity_id, email, role, department, token_hash, invited_by)
  values (v_company, v_email, v_role, v_department,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning * into v_invite;

  return json_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'email', v_invite.email,
    'role', v_invite.role,
    'department', v_invite.department,
    'expires_at', v_invite.expires_at,
    'token', v_token
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.create_org_invite(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_org_invite(text, text, text) TO authenticated;

-- ── 2. Permissive policies that production no longer has ─────
do $$
declare
  t text;
begin
  foreach t in array array['factories', 'po_headers', 'po_lines', 'po_costing', 'po_costing_lines'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_select_auth', t);
      execute format('drop policy if exists %I on public.%I', t || '_write_auth', t);
    end if;
  end loop;

  foreach t in array array['launch_tasks', 'launch_assets', 'launch_comments', 'launch_system_links'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_auth_all', t);
    end if;
  end loop;

  if to_regclass('public.launch_comments') is not null then
    drop policy if exists launch_comments_select_auth on public.launch_comments;
  end if;
end $$;

-- ── 3. generate_next_po_name ─────────────────────────────────
do $$
begin
  if to_regprocedure('public.generate_next_po_name(uuid)') is not null then
    revoke all on function public.generate_next_po_name(uuid) from public, anon;
    grant execute on function public.generate_next_po_name(uuid) to authenticated;
  end if;
end $$;
