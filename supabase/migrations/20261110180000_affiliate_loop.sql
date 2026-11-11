-- Affiliate Studio: close the loop (Blake 2026-11-10: "want things looping").
--
-- 1. A new affiliate gets a code without a staff step. When an affiliate
--    becomes active and has no live or waiting code, a code is queued for the
--    company's own AI to create in Shopify (status 'pending', codes:create):
--    their first name + the program's default % off, e.g. PAT10. The program's
--    default_discount_percent (default 10) sets the % off; NULL turns this off.
--    Fail-soft: anything that stops the code never stops the join.
-- 2. The rep hears when the code is live. When the AI marks a pending code
--    created, the code is stamped live_notice_at; affiliate-invite's
--    deliver_code_notices (service role only) claims each stamp once and
--    emails the rep their code and link. The mcp function kicks it right
--    after the mark; the nightly run sweeps anything the kick missed.
-- 3. Commissions update nightly. affiliate_resolve_attributions and
--    affiliate_accrue_commissions accept the service role (no person, no
--    active company) for scripts/affiliate-commissions.mjs; every other
--    caller keeps the company + manager gate. Both are idempotent.
--
-- Idempotent. Apply after 20261110170000; deploy affiliate-invite and mcp.

-- ---------------------------------------------------------------------------
-- 1. First code on joining
-- ---------------------------------------------------------------------------

alter table public.affiliate_programs
  add column if not exists default_discount_percent integer default 10;
alter table public.affiliate_programs drop constraint if exists affiliate_programs_default_discount_percent;
alter table public.affiliate_programs add constraint affiliate_programs_default_discount_percent
  check (default_discount_percent is null or default_discount_percent between 1 and 100);
comment on column public.affiliate_programs.default_discount_percent is
  'Percent off for the code queued automatically when an affiliate joins (their first name + this number). NULL: no code is queued; a person adds one.';

-- A code nobody in this company uses yet (Shopify codes ignore case):
-- the first name's letters and digits, up to 12, then the percent; a number
-- is added when that is taken.
create or replace function public.affiliate_suggest_code(p_company uuid, p_name text, p_percent integer)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text := left(upper(regexp_replace(split_part(btrim(coalesce(p_name, '')), ' ', 1), '[^A-Za-z0-9]', '', 'g')), 12);
  v_try  text;
  i      integer;
begin
  if length(v_base) < 2 then v_base := 'PARTNER'; end if;
  for i in 1..99 loop
    v_try := v_base || coalesce(p_percent::text, '') || case when i = 1 then '' else '-' || i end;
    if not exists (select 1 from public.affiliate_codes c
                    where c.company_entity_id = p_company and lower(c.code) = lower(v_try)) then
      return v_try;
    end if;
  end loop;
  return v_base || coalesce(p_percent::text, '') || '-' || substr(md5(random()::text), 1, 6);
end;
$$;
revoke all on function public.affiliate_suggest_code(uuid, text, integer) from public, anon, authenticated;

create or replace function public.affiliate_queue_first_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pct   integer;
  v_today date;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
    return null;
  end if;
  if exists (select 1 from public.affiliate_codes c
              where c.company_entity_id = new.company_entity_id
                and c.affiliate_id = new.id
                and c.status in ('active', 'pending')) then
    return null;
  end if;
  select p.default_discount_percent into v_pct
    from public.affiliate_programs p where p.id = new.program_id;
  if v_pct is null then return null; end if;

  -- Joining must never fail because of the code: any refusal (a name that
  -- collides after all, a guard) leaves the affiliate active and codeless,
  -- which the Studio To do list shows.
  begin
    v_today := (now() at time zone public.silo_company_timezone(new.company_entity_id))::date;
    insert into public.affiliate_codes
      (company_entity_id, program_id, affiliate_id, code, starts_on, status, discount_percent)
    values
      (new.company_entity_id, new.program_id, new.id,
       public.affiliate_suggest_code(new.company_entity_id, new.display_name, v_pct),
       v_today, 'pending', v_pct);
  exception when others then
    raise warning 'affiliate_queue_first_code: no code queued for affiliate %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.affiliate_queue_first_code() from public, anon, authenticated;

drop trigger if exists affiliates_queue_first_code on public.affiliates;
create trigger affiliates_queue_first_code
  after insert or update of status on public.affiliates
  for each row execute function public.affiliate_queue_first_code();

-- ---------------------------------------------------------------------------
-- 2. "Your code is live" notice
-- ---------------------------------------------------------------------------

alter table public.affiliate_codes add column if not exists live_notice_at timestamptz;
alter table public.affiliate_codes add column if not exists live_noticed_at timestamptz;
comment on column public.affiliate_codes.live_notice_at is
  'When a code waiting for Shopify went live (the AI marked it created): the rep is owed a "your code is live" email.';
comment on column public.affiliate_codes.live_noticed_at is
  'When that email was claimed for sending (affiliate_claim_code_notices); set once, so it is sent at most once.';

create or replace function public.affiliate_codes_stamp_live()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending' and new.status = 'active' and new.live_notice_at is null then
    new.live_notice_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.affiliate_codes_stamp_live() from public, anon, authenticated;

drop trigger if exists affiliate_codes_stamp_live on public.affiliate_codes;
create trigger affiliate_codes_stamp_live
  before update of status on public.affiliate_codes
  for each row execute function public.affiliate_codes_stamp_live();

-- Claims due notices exactly once (SKIP LOCKED: two senders never take the
-- same code). Only codes still live, of affiliates still active, stamped in
-- the last 14 days. Service role only.
create or replace function public.affiliate_claim_code_notices(p_code uuid default null, p_limit integer default 50)
returns table (code_id uuid, company_entity_id uuid, program_id uuid, affiliate_id uuid, code text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select c.id
      from public.affiliate_codes c
      join public.affiliates a on a.id = c.affiliate_id and a.company_entity_id = c.company_entity_id
     where c.live_notice_at is not null
       and c.live_noticed_at is null
       and c.live_notice_at > now() - interval '14 days'
       and c.status = 'active'
       and a.status = 'active'
       and (p_code is null or c.id = p_code)
     order by c.live_notice_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of c skip locked
  )
  update public.affiliate_codes c
     set live_noticed_at = now()
    from due
   where c.id = due.id
  returning c.id, c.company_entity_id, c.program_id, c.affiliate_id, c.code;
end;
$$;
revoke all on function public.affiliate_claim_code_notices(uuid, integer) from public, anon, authenticated;
grant execute on function public.affiliate_claim_code_notices(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Nightly commissions: the two calculation steps accept the service role
-- ---------------------------------------------------------------------------
--
-- Restated from 20261110085000 with ONLY the permission check changed
-- (verify_v2_schema asserts the rest is intact by its distinctive lines).

create or replace function public.affiliate_resolve_attributions(
  p_program uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     public.affiliate_programs;
  v_company  uuid;
  v_tz       text;
  v_run      uuid := gen_random_uuid();
  v_written   integer := 0;
  v_attempted integer := 0;
  v_conflict  integer := 0;
  v_counts   jsonb;
begin
  if p_program is null or p_from is null or p_to is null then
    raise exception 'affiliate_resolve_attributions: program and date range are required';
  end if;
  if p_to < p_from then
    raise exception 'affiliate_resolve_attributions: p_to is before p_from';
  end if;
  -- Bounded on purpose: `authenticated` has an 8s statement timeout, and a
  -- resolver asked for five years would simply time out halfway and look
  -- broken. A backfill runs it window by window.
  if (p_to - p_from) > 400 then
    raise exception 'affiliate_resolve_attributions: range is % days; resolve at most 400 at a time',
      (p_to - p_from);
  end if;

  select * into v_prog from public.affiliate_programs where id = p_program;
  if not found then
    raise exception 'affiliate_resolve_attributions: no such program';
  end if;
  v_company := v_prog.company_entity_id;

  -- A DEFINER function that takes an id must re-check the caller itself, or it
  -- is an RLS bypass. The program must belong to the caller's ACTIVE company
  -- and the caller must be a manager of it.
  -- The nightly commissions run (scripts/affiliate-commissions.mjs) calls
  -- this with the service role, which has no person and no active company;
  -- everyone else is held to the caller's own company and manager gate
  -- (20261110180000).
  if coalesce(auth.role()::text, '') <> 'service_role'
     and (v_company is distinct from public.active_company_id()
          or not public.can_manage_affiliate_programs()) then
    raise exception 'affiliate_resolve_attributions: not permitted for this company'
      using errcode = '42501';
  end if;

  v_tz := public.silo_company_timezone(v_company);

  with ords as (
    select
      o.shop_domain, o.order_id, o.order_number, o.currency,
      o.subtotal_price, o.refunded_subtotal, o.discount_codes,
      (o.shopify_created_at at time zone v_tz)::date as order_day,
      jsonb_array_length(o.discount_codes) as codes_on_order,
      -- Cancelled orders are READ, not skipped: an order credited before it
      -- was cancelled must come back as a known zero so accrual appends the
      -- reversal. Skipping them left the old positive attribution in place
      -- and the commission payable (review cycle 1, P1).
      (o.cancelled_at is not null) as cancelled
    from public.shopify_orders o
    where o.company_entity_id = v_company
      and o.discount_codes is not null
      and jsonb_array_length(o.discount_codes) > 0
      -- Indexed on (company_entity_id, shopify_created_at). Widened by three
      -- days so no timezone can push a boundary day out of the scan, then
      -- narrowed to the business day below.
      and o.shopify_created_at >= (p_from - 3)::timestamptz
      and o.shopify_created_at <  (p_to + 4)::timestamptz
  ),
  windowed as (
    select * from ords where order_day between p_from and p_to
  ),
  exploded as (
    select w.*, upper(btrim(c.value)) as code
    from windowed w
    cross join lateral jsonb_array_elements_text(w.discount_codes) as c(value)
    where btrim(c.value) <> ''
  ),
  matched as (
    select
      e.*,
      ac.id as code_id,
      ac.affiliate_id,
      (e.order_day >= ac.starts_on
       and e.order_day <= coalesce(ac.ends_on + v_prog.attribution_window_days, 'infinity'::date))
        as in_window
    from exploded e
    join public.affiliate_codes ac
      on ac.company_entity_id = v_company
     and ac.program_id = p_program
     and ac.status = 'active'
     and ac.code = e.code
  ),
  agg as (
    select
      m.shop_domain, m.order_id, m.order_number, m.currency,
      m.subtotal_price, m.refunded_subtotal, m.order_day, m.codes_on_order, m.cancelled,
      count(*) filter (where m.in_window)                        as in_window_codes,
      count(distinct m.affiliate_id) filter (where m.in_window)   as in_window_affiliates,
      (array_agg(m.code      order by m.code) filter (where m.in_window))[1] as win_code,
      (array_agg(m.code_id   order by m.code) filter (where m.in_window))[1] as win_code_id,
      (array_agg(m.affiliate_id order by m.code) filter (where m.in_window))[1] as win_affiliate
    from matched m
    group by 1,2,3,4,5,6,7,8,9
  ),
  decided as (
    select
      a.*,
      case
        when v_prog.code_precedence = 'single_code_only' and a.codes_on_order > 1
          then 'multiple_codes_refused'
        when a.in_window_affiliates = 0 then 'code_outside_window'
        when a.in_window_affiliates > 1 then 'ambiguous_multiple_affiliate_codes'
        when a.cancelled then 'order_cancelled'
        when upper(coalesce(a.currency, '')) <> v_prog.currency then 'currency_mismatch'
        when a.subtotal_price is null or a.refunded_subtotal is null then 'refunds_not_measured'
        when a.codes_on_order = 1 then 'single_affiliate_code'
        else 'first_affiliate_code'
      end as basis
    from agg a
  ),
  shaped as (
    select
      d.*,
      d.basis in ('single_affiliate_code','first_affiliate_code') as earns,
      public.affiliate_currency_minor_units(d.currency) as minor
    from decided d
  ),
  upserted as (
    insert into public.affiliate_attributions (
      company_entity_id, program_id, affiliate_id, affiliate_code_id,
      shop_domain, order_id, order_number, order_day, order_currency,
      codes_on_order, matched_code, basis,
      gross_subtotal_cents, refunded_subtotal_cents, commissionable_cents,
      run_id, attributed_at, updated_at
    )
    select
      v_company, p_program,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_affiliate end,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_code_id end,
      s.shop_domain, s.order_id, s.order_number, s.order_day, upper(nullif(s.currency, '')),
      s.codes_on_order,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_code end,
      s.basis,
      case when s.subtotal_price    is null then null
           else round(s.subtotal_price * s.minor)::bigint end,
      case when s.refunded_subtotal is null then null
           else round(s.refunded_subtotal * s.minor)::bigint end,
      -- Clamped at zero: a refund larger than the merchandise subtotal
      -- (shipping refunded alongside it, say) must not create a NEGATIVE
      -- commissionable base, which would claw back more than was ever earned.
      case when s.basis = 'order_cancelled' then 0::bigint
           when s.earns
            and s.subtotal_price is not null
            and s.refunded_subtotal is not null
           then greatest(round((s.subtotal_price - s.refunded_subtotal) * s.minor)::bigint, 0)
           else null end,
      v_run, now(), now()
    from shaped s
    on conflict (company_entity_id, shop_domain, order_id) do update
      set program_id              = excluded.program_id,
          affiliate_id            = excluded.affiliate_id,
          affiliate_code_id       = excluded.affiliate_code_id,
          order_number            = excluded.order_number,
          order_day               = excluded.order_day,
          order_currency          = excluded.order_currency,
          codes_on_order          = excluded.codes_on_order,
          matched_code            = excluded.matched_code,
          basis                   = excluded.basis,
          gross_subtotal_cents    = excluded.gross_subtotal_cents,
          refunded_subtotal_cents = excluded.refunded_subtotal_cents,
          commissionable_cents    = excluded.commissionable_cents,
          run_id                  = excluded.run_id,
          updated_at              = now()
      -- An order another program already owns is NOT taken over. The unique
      -- key is the order, so without this a second program's run would
      -- silently move an attributed order (and, after the next accrual, the
      -- money) from one affiliate to another.
      where affiliate_attributions.program_id = excluded.program_id
    returning 1
  )
  -- Every shaped row either inserts, or updates and returns 1, or is filtered
  -- out by the DO UPDATE ... WHERE above -- which happens for exactly one
  -- reason: the order already belongs to another program. So the difference
  -- IS the cross-program conflict count, with no second pass over the orders.
  select (select count(*) from upserted), (select count(*) from shaped)
    into v_written, v_attempted;

  v_conflict := v_attempted - v_written;

  -- A cancelled order reverses what it earned even when its code no longer
  -- matches (retired, re-dated or removed since it was credited): the matching
  -- above only sees ACTIVE codes, so this pass works from the stored
  -- attribution and its affiliate instead. The known entitlement becomes
  -- zero and the next accrual appends the negative delta (review cycle 2, P1).
  update public.affiliate_attributions a
     set basis                = 'order_cancelled',
         commissionable_cents = 0,
         run_id               = v_run,
         updated_at           = now()
    from public.shopify_orders o
   where a.company_entity_id = v_company
     and a.program_id = p_program
     and a.affiliate_id is not null
     and a.basis <> 'order_cancelled'
     and a.order_day between p_from and p_to
     and o.company_entity_id = v_company
     and o.shop_domain = a.shop_domain
     and o.order_id = a.order_id
     and o.cancelled_at is not null;

  -- Stamp the codes SILO has now actually SEEN on a real order. With no
  -- Shopify write scope this is the only confirmation available that a code
  -- recorded here exists in the merchant's admin at all.
  update public.affiliate_codes ac
     set verified_at = coalesce(ac.verified_at, now()),
         first_seen_order_id = coalesce(ac.first_seen_order_id, seen.order_id)
    from (
      select a.affiliate_code_id, min(a.order_id) as order_id
        from public.affiliate_attributions a
       where a.company_entity_id = v_company
         and a.program_id = p_program
         and a.affiliate_code_id is not null
       group by 1
    ) seen
   where ac.id = seen.affiliate_code_id
     and ac.company_entity_id = v_company
     and ac.verified_at is null;

  select jsonb_object_agg(basis, n) into v_counts
    from (
      select basis, count(*) as n
        from public.affiliate_attributions
       where company_entity_id = v_company
         and program_id = p_program
         and order_day between p_from and p_to
       group by 1
    ) t;

  return jsonb_build_object(
    'run_id', v_run,
    'program_id', p_program,
    'from', p_from,
    'to', p_to,
    'timezone', v_tz,
    'rows_written', v_written,
    'conflict_other_program', v_conflict,
    'by_basis', coalesce(v_counts, '{}'::jsonb)
  );
end;
$$;

create or replace function public.affiliate_accrue_commissions(
  p_program uuid,
  p_from date,
  p_to date,
  p_period uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     public.affiliate_programs;
  v_company  uuid;
  v_run      uuid := gen_random_uuid();
  v_actor    uuid := auth.uid();
  v_accrued  integer := 0;
  v_reduced  integer := 0;
  v_unchanged integer := 0;
  v_skipped_inactive integer := 0;
  v_skipped_unknown  integer := 0;
  v_total    bigint := 0;
  r          record;
  v_entitled bigint;
  v_existing bigint;
  v_delta    bigint;
  v_period   uuid;
begin
  if p_program is null or p_from is null or p_to is null then
    raise exception 'affiliate_accrue_commissions: program and date range are required';
  end if;
  if p_to < p_from then
    raise exception 'affiliate_accrue_commissions: p_to is before p_from';
  end if;

  select * into v_prog from public.affiliate_programs where id = p_program;
  if not found then
    raise exception 'affiliate_accrue_commissions: no such program';
  end if;
  v_company := v_prog.company_entity_id;

  -- The nightly commissions run (scripts/affiliate-commissions.mjs) calls
  -- this with the service role, which has no person and no active company;
  -- everyone else is held to the caller's own company and manager gate
  -- (20261110180000).
  if coalesce(auth.role()::text, '') <> 'service_role'
     and (v_company is distinct from public.active_company_id()
          or not public.can_manage_affiliate_programs()) then
    raise exception 'affiliate_accrue_commissions: not permitted for this company'
      using errcode = '42501';
  end if;

  -- One accrual per program at a time. Each attribution's delta is "what is
  -- owed now minus what the ledger holds", so two overlapping runs could both
  -- read $0 held and both append the full $10 (review cycle 1, P1). The same
  -- program lock is taken by building and approving a payout, so a payout is
  -- never assembled from a ledger an accrual is half-way through.
  perform public.affiliate_lock_program_money(p_program);

  if p_period is not null then
    perform 1 from public.affiliate_commission_periods
      where id = p_period and company_entity_id = v_company and program_id = p_program;
    if not found then
      raise exception 'affiliate_accrue_commissions: period does not belong to this program';
    end if;
    -- An approved or paid period is closed. Appending to it after the money
    -- was released would change a number somebody signed off; the entry
    -- belongs to whichever period now contains its order day, or to none.
    perform 1 from public.affiliate_commission_periods
      where id = p_period and status in ('approved','paid');
    if found then
      raise exception 'affiliate_accrue_commissions: period % is already %, so it cannot take new entries',
        p_period, (select status from public.affiliate_commission_periods where id = p_period);
    end if;
  end if;

  for r in
    select
      a.id as attribution_id, a.affiliate_id, a.order_id, a.order_day,
      a.commissionable_cents, a.order_currency,
      af.status as affiliate_status,
      coalesce(af.commission_kind, v_prog.commission_kind) as kind,
      case when af.commission_kind is null then v_prog.commission_percent
           else af.commission_percent end as pct,
      case when af.commission_kind is null then v_prog.commission_fixed_cents
           else af.commission_fixed_cents end as fixed
    from public.affiliate_attributions a
    join public.affiliates af
      on af.id = a.affiliate_id and af.company_entity_id = v_company
    where a.company_entity_id = v_company
      and a.program_id = p_program
      and a.order_day between p_from and p_to
      and a.affiliate_id is not null
    order by a.order_day, a.order_id
  loop
    if r.commissionable_cents is null then
      -- currency_mismatch or refunds_not_measured: the base is UNKNOWN, and
      -- an unknown base accrues nothing. Counted, never guessed.
      v_skipped_unknown := v_skipped_unknown + 1;
      continue;
    end if;

    v_entitled := case r.kind
      when 'percent_of_net' then round(r.commissionable_cents * coalesce(r.pct, 0) / 100.0)::bigint
      -- A fully refunded order earns no flat fee either: the fee is per
      -- SALE, and a sale that came back is not one.
      when 'fixed_per_order' then case when r.commissionable_cents > 0
                                       then coalesce(r.fixed, 0)::bigint else 0::bigint end
      else 0::bigint
    end;

    select coalesce(sum(l.amount_cents), 0) into v_existing
      from public.affiliate_commission_ledger l
     where l.company_entity_id = v_company
       and l.attribution_id = r.attribution_id
       and l.kind in ('accrual','refund_adjustment');

    v_delta := v_entitled - v_existing;

    -- A paused or terminated affiliate earns nothing NEW, but a refund or
    -- cancellation on what they already earned is still taken back:
    -- skipping them entirely left the old commission payable (review cycle 1).
    if r.affiliate_status <> 'active' and v_delta > 0 then
      v_skipped_inactive := v_skipped_inactive + 1;
      continue;
    end if;

    if v_delta = 0 then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    v_period := p_period;
    if v_period is null then
      select pr.id into v_period
        from public.affiliate_commission_periods pr
       where pr.company_entity_id = v_company
         and pr.program_id = p_program
         and pr.status in ('open','under_review')
         and r.order_day between pr.period_start and pr.period_end
       order by pr.period_start desc
       limit 1;
    end if;

    insert into public.affiliate_commission_ledger (
      company_entity_id, program_id, affiliate_id, period_id, attribution_id,
      kind, amount_cents, currency, rate_kind, rate_value, basis_cents,
      order_id, order_day, source, memo, run_id, created_by
    ) values (
      v_company, p_program, r.affiliate_id, v_period, r.attribution_id,
      case when v_delta < 0 then 'refund_adjustment' else 'accrual' end,
      v_delta, v_prog.currency, r.kind,
      case when r.kind = 'percent_of_net' then r.pct else r.fixed end,
      r.commissionable_cents,
      r.order_id, r.order_day, 'resolver',
      case when v_delta < 0
           then 'commissionable base fell to ' || r.commissionable_cents || ' minor units'
           else null end,
      v_run, v_actor
    );

    v_total := v_total + v_delta;
    if v_delta < 0 then v_reduced := v_reduced + 1; else v_accrued := v_accrued + 1; end if;
  end loop;

  return jsonb_build_object(
    'run_id', v_run,
    'program_id', p_program,
    'from', p_from, 'to', p_to,
    'currency', v_prog.currency,
    'entries_accrued', v_accrued,
    'entries_reduced', v_reduced,
    'unchanged', v_unchanged,
    'skipped_inactive_affiliate', v_skipped_inactive,
    'skipped_unknown_base', v_skipped_unknown,
    'net_amount_cents', v_total
  );
end;
$$;

revoke execute on function public.affiliate_resolve_attributions(uuid, date, date) from public, anon;
grant execute on function public.affiliate_resolve_attributions(uuid, date, date) to authenticated, service_role;
revoke execute on function public.affiliate_accrue_commissions(uuid, date, date, uuid) from public, anon;
grant execute on function public.affiliate_accrue_commissions(uuid, date, date, uuid) to authenticated, service_role;

-- The nightly run records itself like every other sync: append the job type
-- to the LIVE list (read, not retyped), as 20261110084000 does.
do $$
declare
  cur text;
  members text;
begin
  select pg_get_constraintdef(oid) into cur
    from pg_constraint
   where conname = 'sync_jobs_job_type_check' and conrelid = 'public.sync_jobs'::regclass;
  if cur is null then
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding affiliate_commissions';
  end if;
  if cur ~ '''affiliate_commissions''' then
    return;
  end if;
  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;
  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'affiliate_commissions'
  );
end $$;

-- New columns on public tables: refresh Ask SILO's map.
select public.refresh_chat_schema_catalog();
