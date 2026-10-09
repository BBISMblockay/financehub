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
--
-- 4. sample-notify is a public edge function (the trigger cannot present a
--    JWT), so anyone who knew a sample id could make it email and post as if
--    the trigger had fired, and concurrent calls could all slip past a
--    "sent already?" read. Two parts here (review cycles 1-2):
--    a. notify_sample_events() now SIGNS its calls: header
--       x-silo-trigger-secret, read from Vault secret
--       'sample_notify_trigger_secret', plus a per-transition event_id in the
--       body. Once the function's SAMPLE_NOTIFY_TRIGGER_SECRET is set to the
--       same value, an unsigned call is refused. Logic is otherwise exactly
--       20260910160000 (production's definition, checked 2026-10-09).
--    b. sample_notification_claims: the function inserts a claim (unique per
--       sample, event and transition) BEFORE it sends anything; only the
--       insert that wins proceeds. Service-role only.
--    ROLLOUT ORDER (so notifications never stop): create the Vault secret,
--    apply this migration, deploy sample-notify, THEN set the function secret
--    to the same value. Until the function secret is set the function keeps
--    its state-and-once rules.
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

-- ── 4a. sample-notify claims (atomic once-only) ──────────────
create table if not exists public.sample_notification_claims (
  sample_id uuid not null,
  event_type text not null,
  claim_key text not null,
  company_entity_id uuid,
  created_at timestamptz not null default now(),
  primary key (sample_id, event_type, claim_key)
);
alter table public.sample_notification_claims enable row level security;
-- deliberately no policies: written and read only by sample-notify's service role
revoke all on public.sample_notification_claims from public, anon, authenticated;

-- ── 4b. notify_sample_events(): signed calls ────────────────
create or replace function public.notify_sample_events()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_headers jsonb;
begin
  -- Read only when a call is about to be made. A missing Vault secret sends an
  -- empty header: the function then refuses it once its own secret is set
  -- (see the rollout order above), and accepts it until then.
  if (tg_op = 'INSERT'
        and (new.assigned_to is not null or new.request_source is not null)
        and (new.size_requests is null or btrim(new.size_requests) = ''))
     or (new.request_source = 'catalog_photo_request'
        and new.size_requests is not null and btrim(new.size_requests) <> ''
        and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests)) then
    v_headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-silo-trigger-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'sample_notify_trigger_secret' limit 1), ''));
  end if;

  if tg_op = 'INSERT'
     and (new.assigned_to is not null or new.request_source is not null)
     and (new.size_requests is null or btrim(new.size_requests) = '') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
                     then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new),
        'event_id', gen_random_uuid()
      ),
      headers := v_headers
    );
  end if;

  if new.request_source = 'catalog_photo_request'
     and new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new), 'event_id', gen_random_uuid()),
      headers := v_headers
    );
  end if;

  return new;
end;
$function$;

do $$
begin
  if to_regprocedure('public.attach_stamp_company_entity_id_triggers()') is not null then
    perform public.attach_stamp_company_entity_id_triggers();
  end if;
end $$;
