-- Business-timezone sweep, part 5 of 5, applied LAST on purpose: with every
-- day-boundary site fixed by 20260924130000-130300, onboarding may now accept
-- the US mainland timezones. See 20260924130000's header for the whole sweep
-- and why Alaska and Hawaii are not in this list.

-- ── 1. Timezones now honoured end to end ───────────────────────────────────
insert into public.supported_business_timezones (tz_name, label, is_supported, note)
values
  ('America/Denver',   'Mountain Time (US & Canada)', true, 'Added by 20260924130400 (business-timezone sweep).'),
  ('America/Phoenix',  'Arizona (no daylight saving)', true, 'Added by 20260924130400 (business-timezone sweep).'),
  ('America/Chicago',  'Central Time (US & Canada)',  true, 'Added by 20260924130400 (business-timezone sweep).'),
  ('America/New_York', 'Eastern Time (US & Canada)',  true, 'Added by 20260924130400 (business-timezone sweep).')
-- DO NOTHING, not DO UPDATE: a zone somebody later marks unsupported must stay
-- that way when apply_all_post_merge.sql re-runs this file.
on conflict (tz_name) do nothing;

update public.supported_business_timezones
   set note = 'Honoured end to end. The US mainland timezones were added by 20260924130400; Alaska and Hawaii need a sync schedule change first.'
 where tz_name = 'America/Los_Angeles';

-- ── 2. Onboarding: the refusal no longer claims the sweep is unfinished ────

create or replace function public.redeem_platform_invite(
  p_token     text,
  p_company   text,
  p_timezone  text,
  p_currency  text
) returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invite   public.platform_invites%rowtype;
  v_email    text;
  v_name     text;
  v_company  text;
  v_tz       text;
  v_currency text;
  v_key      text;
  v_entity   uuid;
  v_supported boolean;
  v_has_other_org boolean;
  v_is_active boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite from public.platform_invites
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  select lower(email), name into v_email, v_name from public.profiles where id = auth.uid();
  if v_email is null then
    raise exception 'profile not found';
  end if;
  if v_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  -- A disabled account gets ONE answer from this RPC, so the check sits here --
  -- above the idempotent-retry branch, not below it. Placed lower it was
  -- bypassed by a retry, which returned a company and switched the caller's
  -- active_company_id; no escalation, since every helper gates on is_active,
  -- but "disabled, and yet this succeeded" is the kind of inconsistency
  -- somebody later reasons from.
  --
  -- FOR UPDATE because the read and the write below are otherwise a
  -- time-of-check/time-of-use pair: `admin_update_profile(..., is_active =>
  -- false)` committing in between would be undone by the upsert's `else true`
  -- arm. Unclaimed profiles -- no membership anywhere -- are exactly what any
  -- admin may edit, and exactly the branch that takes that arm. Locking the
  -- caller's own row makes the check authoritative for the rest of the
  -- transaction; a concurrent disable waits and then applies last, which is
  -- the right order. MEASURED 2026-09-18 in onboarding-concurrency.test.mjs:
  -- without the lock (ONBOARDING_RACE_MUTATION=redeem-unlocked) the redeem
  -- reads the pre-disable snapshot, founds the company, and writes is_active
  -- back to true -- the administrator's deactivation silently undone.
  select is_active into v_is_active
    from public.profiles where id = auth.uid()
    for update;
  if v_is_active is not null and not v_is_active then
    raise exception 'This account is disabled. An administrator has to reactivate it before it can create a company.';
  end if;

  -- The retry path. A lost response, a reloaded tab, a double-clicked button:
  -- the invite is already accepted and already names the company it made, so
  -- hand that back rather than founding a second one. Still refused for anyone
  -- who is not the accepting user, which the email check above has established.
  if v_invite.status = 'accepted' then
    if v_invite.created_company_id is null then
      raise exception 'invite was already redeemed but no company was recorded -- contact support';
    end if;
    perform public.set_active_company(v_invite.created_company_id);
    -- Same KEYS as the fresh path below, deliberately. The caller caches the
    -- company from this response, and `entity_key` decides which nav profile
    -- the first page paints with (v2/nav-config.js resolveNavProfile). Omitting
    -- it here left the RETRY path -- the one this branch exists to serve, and
    -- so the one a flaky demo connection actually hits -- caching a company
    -- with `entity_key: undefined`. It resolves to the standard menu either
    -- way today, which is right for a new tenant by luck rather than by
    -- construction; two success paths of one function should not return two
    -- shapes.
    return json_build_object(
      'ok', true,
      'repeated', true,
      'entity_id', v_invite.created_company_id,
      'entity_key', (select entity_key from public.entities where id = v_invite.created_company_id),
      'company', (select title from public.entities where id = v_invite.created_company_id),
      'business_timezone', (select business_timezone from public.company_settings
                             where company_entity_id = v_invite.created_company_id),
      'default_currency', (select default_currency from public.company_settings
                            where company_entity_id = v_invite.created_company_id)
    );
  end if;

  if v_invite.status = 'revoked' then
    raise exception 'this invite has been revoked';
  end if;
  if v_invite.expires_at < now() then
    -- No `update ... set status = 'expired'` here: the raise on the next line
    -- aborts the transaction and takes the write with it, so it never
    -- persisted. It read like bookkeeping and did nothing. Expiry is derived
    -- from expires_at wherever it is shown -- list_platform_invites computes it
    -- at read time, and peek_platform_invite refuses on it -- so the stored
    -- value was redundant as well as unreachable.
    raise exception 'this invite has expired -- ask for a new one';
  end if;

  v_company := nullif(trim(coalesce(p_company, '')), '');
  if v_company is null then
    raise exception 'company name is required';
  end if;

  v_currency := upper(nullif(trim(coalesce(p_currency, '')), ''));
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a three-letter code, e.g. USD';
  end if;

  -- The refusal that keeps a stored setting from lying. See section 4 of the
  -- header: the message names what does not honour the setting yet, because
  -- "unsupported" alone reads as arbitrary.
  v_tz := nullif(trim(coalesce(p_timezone, '')), '');
  if v_tz is null then
    raise exception 'business timezone is required';
  end if;
  select is_supported into v_supported
    from public.supported_business_timezones where tz_name = v_tz;
  if v_supported is null or not v_supported then
    raise exception 'SILO does not support % as a business timezone yet. The supported list is in supported_business_timezones; the nightly sync is scheduled after midnight in every US mainland timezone, and a timezone west of Pacific would need its own schedule first.', v_tz;
  end if;

  -- entity_key: slug, de-collided against existing companies. The LOOK-UP is
  -- advisory only -- `entities_unique_key` is UNIQUE (module, entity_type,
  -- entity_key), so two people founding a same-named company in the same
  -- instant would both see no collision and the loser would get a raw 23505
  -- in the middle of signing up. Catching the violation and retrying with a
  -- suffix turns that race into the right answer instead of an error message
  -- nobody can act on. One retry is enough: the suffix is random.
  v_key := trim(both '-' from regexp_replace(lower(v_company), '[^a-z0-9]+', '-', 'g'));
  if v_key = '' then v_key := 'org'; end if;
  if exists (select 1 from public.entities e
              where e.entity_type = 'company' and e.entity_key = v_key) then
    v_key := v_key || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  begin
    insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
    values ('finance_hub', 'company', v_key, 'platform_invite', v_company,
            jsonb_build_object('platform_invite', true, 'invite_id', v_invite.id), auth.uid())
    returning id into v_entity;
  exception when unique_violation then
    v_key := v_key || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
    values ('finance_hub', 'company', v_key, 'platform_invite', v_company,
            jsonb_build_object('platform_invite', true, 'invite_id', v_invite.id), auth.uid())
    returning id into v_entity;
  end;

  -- Does this user already belong to some OTHER company? Asked before the new
  -- membership is inserted, so any row here is another org.
  select exists (
    select 1 from public.entity_memberships em where em.user_id = auth.uid()
  ) into v_has_other_org;

  -- `profiles.is_active` is GLOBAL, exactly like role and department -- one
  -- column for the whole platform, not one per company. The first correction
  -- preserved role and department for a multi-org user and went on writing
  -- `is_active = true` unconditionally, which left the same escalation intact
  -- in its most direct form: an account DISABLED by company A could hold a
  -- still-valid session, redeem a legitimate company-B founding invite, and
  -- have A's deactivation silently undone. The membership in A is untouched by
  -- deactivation, so switching back needs nothing else, and every authorization
  -- helper gates on `p.is_active` -- which is now true again.
  --
  -- So a disabled account cannot found a company at all. Refusing is the right
  -- answer rather than founding-but-not-reactivating: an account somebody
  -- disabled should not be quietly acquiring new tenants either, and a silent
  -- half-success is the harder state to reason about later. Reactivation is a
  -- deliberate act by an admin of the org that disabled them.

  -- `profiles.role` and `profiles.department` are the LEGACY GLOBAL fields --
  -- they are not per-company, and several gates still read them directly.
  -- `can_manage_journal_entries()` admits `p.department in ('finance','exec')`
  -- on its own, independently of membership role, and the comp-request gate
  -- carries the same branch. So writing `department = 'exec'` here for a user
  -- who is a member or viewer of company A would hand them journal-entry
  -- authority in A -- granted by founding B, which A never agreed to. The
  -- unconditional `role = 'owner'` is the same hazard pointing the other way:
  -- it would DEMOTE an existing `executive`.
  --
  -- The convention already exists and is documented in CLAUDE.md: invites and
  -- backend role grants "only touch the global profile role/department when the
  -- user belongs to no other org", which is exactly what `accept_org_invite`
  -- does with this same flag. Founding a company is no different, and this
  -- missed it. Authority over the NEW company comes from the `owner_admin`
  -- membership below, which is per-company and sufficient.
  insert into public.profiles (id, email, name, role, department, is_active, active_company_id)
  values (auth.uid(), v_email, v_name, 'owner'::app_role, 'exec', true, v_entity)
  on conflict (id) do update
    set role = case when v_has_other_org then profiles.role
                    else excluded.role end,
        department = case when v_has_other_org then profiles.department
                          else coalesce(profiles.department, excluded.department) end,
        -- Preserved for a multi-org user for the same reason as role and
        -- department: it is a GLOBAL flag, and founding here must not write
        -- authority there. The refusal above already means this branch can only
        -- be reached by an active profile, so this is defence in depth -- but
        -- if the refusal were ever removed, an unconditional `true` here would
        -- silently restore the escalation.
        is_active = case when v_has_other_org then profiles.is_active else true end,
        active_company_id = excluded.active_company_id,
        updated_at = now();

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity, auth.uid(), 'owner_admin')
  on conflict (entity_id, user_id) do update set role = excluded.role;

  insert into public.company_settings (company_entity_id, business_timezone, default_currency)
  values (v_entity, v_tz, v_currency);

  update public.platform_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now(),
         created_company_id = v_entity
   where id = v_invite.id;

  return json_build_object(
    'ok', true,
    'repeated', false,
    'entity_id', v_entity,
    'entity_key', v_key,
    'company', v_company,
    'business_timezone', v_tz,
    'default_currency', v_currency
  );
end;
$$;
