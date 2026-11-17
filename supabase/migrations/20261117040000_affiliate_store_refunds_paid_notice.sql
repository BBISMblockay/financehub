-- Affiliate Studio: review cycle 1 of #1300, after 20261117030000.
--
-- 1. affiliate_resolve_attributions(): an order the program ALREADY credited
--    is re-read whatever stores are ticked now. 20261117030000 filtered every
--    pass by the current stores, so after a store was unticked a refund on an
--    order it had already credited was never read and the commission stayed
--    payable. Unticking now stops NEW credit only.
-- 2. affiliate_notifications.payout_id: which paid payout a notice announced,
--    so affiliate-invite sends "your payout was paid" once, whichever path
--    asks (Record as paid, a PayPal send, Send all, a later reconciliation,
--    the Studio's catch-up on load).
--
-- Apply AFTER 20261117030000 (it reads affiliate_programs.shop_domains) and
-- BEFORE deploying affiliate-invite. Idempotent; create or replace keeps the
-- resolver's grants and comment.

-- ── 1. Refunds keep being read after a store is unticked ─────────────────
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
      -- Only the stores this program covers; NULL = every store (20261117030000).
      -- An order this program ALREADY credited is always re-read, whatever
      -- the stores are now: unticking a store stops new credit, it must not
      -- freeze a refund correction on credit already given (review cycle 1, P1).
      and (v_prog.shop_domains is null
           or lower(o.shop_domain) = any (v_prog.shop_domains)
           or exists (select 1 from public.affiliate_attributions pa
                       where pa.company_entity_id = v_company
                         and pa.shop_domain = o.shop_domain
                         and pa.order_id = o.order_id
                         and pa.program_id = p_program))
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

-- ── 2. Which paid payout a notice announced ──────────────────────────────
alter table public.affiliate_notifications
  add column if not exists payout_id uuid references public.affiliate_payouts(id) on delete set null;

create index if not exists affiliate_notifications_payout_idx
  on public.affiliate_notifications (company_entity_id, payout_id)
  where payout_id is not null;

comment on column public.affiliate_notifications.payout_id is
  'The paid payout this payout_status notice announced. affiliate-invite sends a paid notice only when no sent row carries that payout. 20261117030000.';
