-- Affiliate payouts: re-check refunds at the moment of paying (audit 2026-11-18).
--
-- affiliate_approve_payout() refuses a draft when a refund or other reduction
-- landed after it was built. Nothing re-checked at SEND time, so a refund that
-- arrived between approval and send left the old, larger amount queued for
-- PayPal, and the same for a CSV export. Both claims now run the approval's
-- check inside the program's money lock:
--   - affiliate_payout_send_claim refuses (55000), nothing is reserved and
--     nothing reaches PayPal; the payout is voided and built again.
--   - affiliate_claim_payout_export leaves such a payout out of the batch, so
--     it comes back in `skipped` (the page already reports skipped payouts).
-- An "unclaimed negative" is the same definition approval uses: a ledger line
-- below zero for that affiliate and currency that no payout has claimed yet.
-- Building a payout claims every unclaimed line, so one only exists when it
-- arrived after the build.
--
-- Bodies are the live production definitions (read 2026-11-19) with only the
-- new check added. create or replace keeps grants; they are restated anyway.

create or replace function public.affiliate_payout_has_new_reductions(p_payout uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(l.amount_cents), 0)::bigint
    from public.affiliate_payouts p
    join public.affiliate_commission_ledger l
      on l.company_entity_id = p.company_entity_id
     and l.affiliate_id = p.affiliate_id
     and l.currency = p.currency
   where p.id = p_payout
     and l.amount_cents < 0
     and not exists (select 1 from public.affiliate_payout_items i where i.ledger_entry_id = l.id);
$$;
revoke all on function public.affiliate_payout_has_new_reductions(uuid) from public, anon, authenticated;
grant execute on function public.affiliate_payout_has_new_reductions(uuid) to service_role;

create or replace function public.affiliate_payout_send_claim(p_payout uuid, p_company uuid, p_environment text, p_actor uuid default null::uuid, p_connection_fingerprint text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payout  public.affiliate_payouts;
  v_email   text;
  v_attempt integer;
  v_open    text;
  v_send    uuid;
  v_request text;
  v_newer   bigint;
begin
  select * into v_payout from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_payout_send_claim: no such payout'; end if;

  -- THE TENANT CHECK, and it has to be here. This function runs as the service
  -- role, which bypasses RLS, and the payout id reaches it from a request
  -- body: without this, a person with money authority at one company could
  -- send another company's payout -- paying that company's affiliate out of
  -- their own PayPal, and learning the address. The caller's company is read
  -- from their own profile by the edge function and passed in; it is never
  -- taken from the request.
  if p_company is null or v_payout.company_entity_id is distinct from p_company then
    raise exception 'affiliate_payout_send_claim: that payout belongs to another company'
      using errcode = '42501';
  end if;

  if v_payout.method <> 'paypal_payouts' then
    raise exception 'affiliate_payout_send_claim: payout method is %, not paypal_payouts', v_payout.method
      using errcode = '0A000';
  end if;
  if v_payout.status not in ('approved','exported') then
    raise exception 'affiliate_payout_send_claim: a payout is sent only once it is approved (this one is %)', v_payout.status
      using errcode = '42501';
  end if;

  -- One program's money at a time, the same lock accrual and approval take, so
  -- a refund cannot be accrued into this payout while it is being sent.
  perform public.affiliate_lock_program_money(v_payout.program_id);

  -- Re-read inside the lock: approval or a void may have landed between the
  -- read above and the lock being granted.
  select * into v_payout from public.affiliate_payouts where id = p_payout;
  if v_payout.status not in ('approved','exported') then
    raise exception 'affiliate_payout_send_claim: payout is now % -- reload', v_payout.status
      using errcode = '42501';
  end if;

  -- A refund or reduction that arrived after this payout was built means the
  -- approved amount is now too much (audit 2026-11-18). Inside the lock, so
  -- one cannot land between this check and the reservation below.
  v_newer := public.affiliate_payout_has_new_reductions(p_payout);
  if v_newer < 0 then
    raise exception 'affiliate_payout_send_claim: % minor units of refunds or reductions arrived after this payout was built. Nothing was sent. Void it and build it again.', -v_newer
      using errcode = '55000';
  end if;

  -- Which earlier attempts stand in the way. A LIVE attempt blocks everything,
  -- because real money is at or on its way to the affiliate. A SANDBOX attempt
  -- blocks only another sandbox attempt: no money moved, nothing was settled
  -- (affiliate_payout_send_record refuses to mark a payout paid from a sandbox
  -- result), so a rehearsal must not make the real payment unsendable --
  -- review cycle 1, finding 3.
  select state into v_open
    from public.affiliate_payout_sends
   where payout_id = p_payout
     and state in ('unknown','sent','unclaimed','paid')
     and (environment = 'live' or environment = p_environment)
   order by attempt desc
   limit 1;
  if v_open is not null then
    if v_open = 'unknown' then
      raise exception 'affiliate_payout_send_claim: an earlier attempt never reported an answer. Check it against the provider before sending again -- it may already have been accepted.'
        using errcode = '55006';
    end if;
    raise exception 'affiliate_payout_send_claim: this payout already has an attempt in state %', v_open
      using errcode = '55006';
  end if;

  select payout_email into v_email
    from public.affiliate_payout_accounts
   where company_entity_id = v_payout.company_entity_id
     and affiliate_id = v_payout.affiliate_id
     and provider = 'paypal';
  if btrim(coalesce(v_email, '')) = '' then
    raise exception 'affiliate_payout_send_claim: this affiliate has not given a PayPal address yet'
      using errcode = '22023';
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt
    from public.affiliate_payout_sends where payout_id = p_payout;

  -- Deterministic, so the SAME attempt replayed is the same request to PayPal.
  v_request := 'silo-' || replace(p_payout::text, '-', '') || '-' || v_attempt::text;

  insert into public.affiliate_payout_sends (
    company_entity_id, payout_id, provider, environment, attempt,
    request_id, sender_batch_id, amount_cents, currency, payout_email,
    state, connection_fingerprint, created_by
  ) values (
    v_payout.company_entity_id, p_payout, 'paypal', p_environment, v_attempt,
    v_request, v_request, v_payout.amount_cents, v_payout.currency, v_email,
    'unknown', p_connection_fingerprint, p_actor
  ) returning id into v_send;

  return jsonb_build_object(
    'send_id', v_send,
    'request_id', v_request,
    'sender_batch_id', v_request,
    'attempt', v_attempt,
    'amount_cents', v_payout.amount_cents,
    'currency', v_payout.currency,
    'payout_email', v_email,
    'connection_fingerprint', p_connection_fingerprint,
    'company_entity_id', v_payout.company_entity_id
  );
end;
$function$;
revoke all on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid, text) to service_role;

create or replace function public.affiliate_claim_payout_export(p_program uuid, p_payouts uuid[] default null::uuid[], p_batch uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_company uuid;
  v_batch   uuid := p_batch;
  v_rows    jsonb;
begin
  select company_entity_id into v_company from public.affiliate_programs where id = p_program;
  if v_company is null
     or v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_claim_payout_export: not permitted' using errcode = '42501';
  end if;
  perform public.affiliate_lock_program_money(p_program);

  if v_batch is null then
    if coalesce(array_length(p_payouts, 1), 0) = 0 then
      raise exception 'affiliate_claim_payout_export: no payouts were chosen';
    end if;
    v_batch := gen_random_uuid();
    -- A payout with a refund that arrived after it was built is left out
    -- (audit 2026-11-18): it comes back in `skipped`, to be voided and built
    -- again, rather than exported for the old, larger amount.
    update public.affiliate_payouts
       set status = 'exported', exported_by = auth.uid(), exported_at = now(), export_batch_id = v_batch
     where id = any(p_payouts)
       and company_entity_id = v_company
       and program_id = p_program
       and status = 'approved'
       and public.affiliate_payout_has_new_reductions(id) = 0;
    if not found then
      raise exception 'affiliate_claim_payout_export: none of those payouts is still approved with no new refunds -- reload the page';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'affiliate_id', p.affiliate_id, 'amount_cents', p.amount_cents,
           'currency', p.currency, 'approved_at', p.approved_at, 'status', p.status,
           'item_count', (select count(*) from public.affiliate_payout_items i where i.payout_id = p.id))
         order by p.created_at, p.id), '[]'::jsonb)
    into v_rows
    from public.affiliate_payouts p
   where p.company_entity_id = v_company
     and p.program_id = p_program
     and p.export_batch_id = v_batch
     and p.status = 'exported';

  if p_batch is not null and v_rows = '[]'::jsonb then
    raise exception 'affiliate_claim_payout_export: nothing in that export is still waiting to be paid';
  end if;

  return jsonb_build_object('batch_id', v_batch, 'payouts', v_rows,
    'skipped', coalesce((select jsonb_agg(x) from unnest(coalesce(p_payouts, '{}'::uuid[])) x
                          where p_batch is null
                            and not exists (select 1 from public.affiliate_payouts q
                                             where q.id = x and q.export_batch_id = v_batch)), '[]'::jsonb));
end;
$function$;
revoke all on function public.affiliate_claim_payout_export(uuid, uuid[], uuid) from public, anon;
grant execute on function public.affiliate_claim_payout_export(uuid, uuid[], uuid) to authenticated, service_role;
