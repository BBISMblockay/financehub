-- 20261118010000: one affiliate per company, in as many programs as the brand
-- likes, each with its own rate (Blake 2026-11-17: "per company, can
-- participate in multiple programs etc."; the affiliate base is the moat, so
-- onboard ONCE, then add to programs with no second signup).
--
-- The ledger, codes, payouts and portal are all program-scoped through
-- affiliates.program_id, and each affiliates row already carries its own rate
-- override (commission_kind / _percent / _fixed_cents, read by
-- affiliate_effective_rate). So a program membership IS an affiliates row:
-- this function adds one for a person who is already active in another
-- program of the SAME company, active at once, with the rate the brand picks.
-- Nothing in the ledger changes. The rep's portal already lists every program
-- they are in (affiliate_portal_brands matches on their mailed address), so
-- each program's earnings show there.
--
-- Terms: the person signed this company's terms in their first program. The
-- new row records that acceptance as CARRIED (terms_acceptance.carried_from),
-- with the version of the new program's terms, rather than inventing a fresh
-- signature they never made.
--
-- Safe by construction: the caller must manage affiliate programs in the
-- ACTIVE company, and the source person, the target program and the new row
-- are all that company's. A person already in the target program is returned,
-- never duplicated (affiliates_identity is unique per program and email).

create or replace function public.affiliate_add_to_program(
  p_affiliate uuid,
  p_program uuid,
  p_commission_kind text default null,
  p_commission_percent numeric default null,
  p_commission_fixed_cents integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_src public.affiliates%rowtype;
  v_prog public.affiliate_programs%rowtype;
  v_existing uuid;
  v_new uuid;
begin
  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_add_to_program: not allowed' using errcode = '42501';
  end if;

  select * into v_src from public.affiliates
   where id = p_affiliate and company_entity_id = v_company;
  if not found then
    raise exception 'affiliate_add_to_program: no such affiliate in this company' using errcode = 'P0002';
  end if;
  if v_src.status not in ('active', 'paused') or v_src.terms_accepted_at is null then
    raise exception 'affiliate_add_to_program: only someone who has joined can be added to another program' using errcode = '22023';
  end if;

  select * into v_prog from public.affiliate_programs
   where id = p_program and company_entity_id = v_company;
  if not found then
    raise exception 'affiliate_add_to_program: no such program in this company' using errcode = 'P0002';
  end if;
  if v_prog.status <> 'active' then
    raise exception 'affiliate_add_to_program: that program is not active' using errcode = '22023';
  end if;

  if p_commission_kind is not null and p_commission_kind not in ('percent_of_net', 'fixed_per_order') then
    raise exception 'affiliate_add_to_program: unknown rate kind' using errcode = '22023';
  end if;

  select id into v_existing from public.affiliates
   where company_entity_id = v_company and program_id = p_program
     and lower(contact_email) = lower(v_src.contact_email)
   limit 1;
  if v_existing is not null then
    return jsonb_build_object('affiliate_id', v_existing, 'added', false);
  end if;

  insert into public.affiliates (
    company_entity_id, program_id, display_name, contact_email, contact_name, platform, handle, profile_url,
    photo_url, photo_hidden, status, terms_version_accepted, terms_accepted_at, terms_acceptance,
    commission_kind, commission_percent, commission_fixed_cents,
    from_prospect_id, approved_by, approved_at, note, created_by, changed_by
  ) values (
    v_company, p_program, v_src.display_name, v_src.contact_email, v_src.contact_name, v_src.platform, v_src.handle, v_src.profile_url,
    v_src.photo_url, coalesce(v_src.photo_hidden, false), 'active', v_prog.terms_version, now(),
    jsonb_build_object('carried_from', v_src.id, 'carried_from_program', v_src.program_id,
      'original_accepted_at', v_src.terms_accepted_at, 'original_terms_version', v_src.terms_version_accepted,
      'added_by', auth.uid(), 'basis', 'added to another program of the same company'),
    p_commission_kind,
    case when p_commission_kind = 'percent_of_net' then p_commission_percent end,
    case when p_commission_kind = 'fixed_per_order' then p_commission_fixed_cents end,
    v_src.from_prospect_id, auth.uid(), now(), null, auth.uid(), auth.uid()
  ) returning id into v_new;

  -- Where they are paid follows them: their PayPal email, if they gave one.
  insert into public.affiliate_payout_accounts (company_entity_id, affiliate_id, provider, payout_email)
  select v_company, v_new, x.provider, x.payout_email
    from public.affiliate_payout_accounts x
   where x.company_entity_id = v_company and x.affiliate_id = v_src.id and x.provider = 'paypal' and x.payout_email is not null
  on conflict do nothing;

  return jsonb_build_object('affiliate_id', v_new, 'added', true);
end;
$$;

comment on function public.affiliate_add_to_program(uuid, uuid, text, numeric, integer) is
  'Adds a person already active in one program of the active company to another of its programs, active at once, with an optional rate of its own. Terms are recorded as carried from their first acceptance. Returns {affiliate_id, added}; a person already in the program is returned, not duplicated. can_manage_affiliate_programs() only. (20261118010000)';

revoke execute on function public.affiliate_add_to_program(uuid, uuid, text, numeric, integer) from public, anon;
grant execute on function public.affiliate_add_to_program(uuid, uuid, text, numeric, integer) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'silo_integration') then
    execute 'revoke execute on function public.affiliate_add_to_program(uuid, uuid, text, numeric, integer) from silo_integration';
  end if;
end $$;
