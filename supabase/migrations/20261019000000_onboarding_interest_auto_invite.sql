-- Auto-invite for early-access leads (Blake, 2026-10-19).
--
-- Until now a lead only waited in onboarding_interest_queue until a platform
-- admin minted a founding invite by hand. These two service-role-only
-- functions let the onboarding-interest-invite edge function do that minting
-- itself, bounded by a daily cap, and record what happened.
--
-- Nothing here is reachable from the browser: both functions are granted to
-- service_role only, and the edge function that calls them is itself switched
-- on by a secret (ONBOARDING_AUTO_INVITE=true). Applying this migration alone
-- changes no behaviour.

alter table public.onboarding_interest_queue
  add column if not exists auto_invited_at timestamptz;

comment on column public.onboarding_interest_queue.auto_invited_at is
  'Set when the system minted this lead''s founding invite. Counts against the daily auto-invite cap whether or not the email then sent, so a failing mail provider cannot loop.';

-- ── claim_auto_invite ───────────────────────────────────────────────────────
-- Mints one founding invite for a pending, not-yet-invited lead, if today's
-- cap allows. Returns the raw token ONCE, to the edge function that emails it.
create or replace function public.claim_auto_invite(p_email text, p_daily_cap integer)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_lead   public.onboarding_interest_queue%rowtype;
  v_token  text;
  v_invite public.platform_invites%rowtype;
begin
  if v_email = '' or p_daily_cap is null or p_daily_cap < 1 then
    return jsonb_build_object('claimed', false, 'reason', 'invalid');
  end if;

  -- One claimer at a time, so two concurrent submissions cannot both pass the
  -- cap check. Same lock-before-read stance as submit_onboarding_interest.
  perform pg_catalog.pg_advisory_xact_lock(735214901, 2);

  select * into v_lead from public.onboarding_interest_queue where email = v_email;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'no_lead');
  end if;
  if v_lead.status <> 'pending' or v_lead.auto_invited_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_handled');
  end if;

  -- Never supersede an invite a person already sent by hand: minting a new
  -- one would revoke the link they gave this founder.
  if exists (select 1 from public.platform_invites
              where lower(email) = v_email and status = 'pending' and expires_at > now()) then
    return jsonb_build_object('claimed', false, 'reason', 'invite_exists');
  end if;

  if (select count(*) from public.onboarding_interest_queue
       where auto_invited_at > now() - interval '1 day') >= p_daily_cap then
    return jsonb_build_object('claimed', false, 'reason', 'cap');
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.platform_invites (email, suggested_company, token_hash, invited_by)
  values (v_email, nullif(btrim(v_lead.company_name), ''),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), null)
  returning * into v_invite;

  update public.onboarding_interest_queue set auto_invited_at = now() where id = v_lead.id;

  return jsonb_build_object(
    'claimed', true,
    'invite_id', v_invite.id,
    'token', v_token,
    'email', v_invite.email,
    'name', v_lead.name,
    'company_name', v_lead.company_name
  );
end;
$fn$;

-- ── finish_auto_invite ──────────────────────────────────────────────────────
-- Records the outcome of the email. Sent: the lead is 'contacted'. Not sent:
-- the unused invite is revoked (its token was never delivered) and the lead
-- stays 'pending' for a person to handle with the Invite button. The lead keeps
-- auto_invited_at on purpose so a failing provider still counts against the cap.
create or replace function public.finish_auto_invite(p_invite_id uuid, p_sent boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email text;
begin
  select email into v_email from public.platform_invites
   where id = p_invite_id and status = 'pending';
  if not found then return; end if;

  if p_sent then
    update public.onboarding_interest_queue set status = 'contacted'
     where email = v_email and status = 'pending' and auto_invited_at is not null;
  else
    update public.platform_invites set status = 'revoked' where id = p_invite_id;
  end if;
end;
$fn$;

revoke all on function public.claim_auto_invite(text, integer) from public, anon, authenticated;
revoke all on function public.finish_auto_invite(uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_auto_invite(text, integer) to service_role;
grant execute on function public.finish_auto_invite(uuid, boolean) to service_role;
