-- Affiliate commissions: refunds and cancellations on ANY credited order
-- (audit 2026-11-18).
--
-- The nightly run re-resolves the last 45 days of orders by ORDER date, and the
-- resolver matches only ACTIVE codes. So two kinds of credited order were never
-- re-read again:
--   - an order older than 45 days that Shopify refunds later (the Shopify sync
--     does refresh it, by updated_at, so shopify_orders has the refund), and
--   - an order credited under a code that has since been retired or ended:
--     its code no longer matches, so the resolver skips it at any age.
-- Either way the commission stayed payable after the money came back.
--
-- affiliate_refresh_credited_orders(program) works from the STORED
-- attributions, not from code matching: every earning attribution of the
-- program whose order now shows a different refund, subtotal or a
-- cancellation gets its base recomputed (the resolver's own formula, clamped at
-- zero), and a refund_adjustment is appended for that order alone. The
-- reduction uses the RATE THE ORDER WAS ACCRUED AT (its own ledger lines), not
-- today's program rate, and only a reduction is ever written: running the
-- full accrual over a year of orders would instead re-price every old order at
-- the current rate. No attribution is added and no affiliate is changed.
-- Called by the nightly commissions run after resolve and accrue.

create or replace function public.affiliate_refresh_credited_orders(p_program uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     public.affiliate_programs;
  v_run      uuid := gen_random_uuid();
  v_changed  integer := 0;
  v_reduced  integer := 0;
  v_total    bigint := 0;
  r          record;
  v_rate     record;
  v_existing bigint;
  v_entitled bigint;
  v_delta    bigint;
  v_period   uuid;
begin
  select * into v_prog from public.affiliate_programs where id = p_program;
  if not found then
    raise exception 'affiliate_refresh_credited_orders: no such program';
  end if;
  -- No caller check in the body: EXECUTE is granted to the service role only
  -- (below), and it only ever reduces credit.

  -- The same lock accrual, payout build and approval take.
  perform public.affiliate_lock_program_money(p_program);

  for r in
    with fresh as (
      select a.id,
             case when o.subtotal_price is null then null
                  else round(o.subtotal_price * public.affiliate_currency_minor_units(o.currency))::bigint end as gross,
             case when o.refunded_subtotal is null then null
                  else round(o.refunded_subtotal * public.affiliate_currency_minor_units(o.currency))::bigint end as refunded,
             (o.cancelled_at is not null) as cancelled
        from public.affiliate_attributions a
        join public.shopify_orders o
          on o.company_entity_id = a.company_entity_id
         and o.shop_domain = a.shop_domain
         and o.order_id = a.order_id
       where a.company_entity_id = v_prog.company_entity_id
         and a.program_id = p_program
         and a.affiliate_id is not null
         and a.basis in ('single_affiliate_code', 'first_affiliate_code')
    )
    update public.affiliate_attributions a
       set basis                   = case when f.cancelled then 'order_cancelled'
                                          when f.gross is null or f.refunded is null then 'refunds_not_measured'
                                          else a.basis end,
           gross_subtotal_cents    = f.gross,
           refunded_subtotal_cents = f.refunded,
           -- Unknown stays unknown, never guessed as zero.
           commissionable_cents    = case when f.cancelled then 0::bigint
                                          when f.gross is null or f.refunded is null then null
                                          else greatest(f.gross - f.refunded, 0) end,
           run_id                  = v_run,
           updated_at              = now()
      from fresh f
     where a.id = f.id
       and (f.cancelled
            or f.gross    is distinct from a.gross_subtotal_cents
            or f.refunded is distinct from a.refunded_subtotal_cents)
    returning a.id, a.affiliate_id, a.order_id, a.order_day, a.commissionable_cents
  loop
    v_changed := v_changed + 1;
    if r.commissionable_cents is null then continue; end if;

    select coalesce(sum(l.amount_cents), 0) into v_existing
      from public.affiliate_commission_ledger l
     where l.company_entity_id = v_prog.company_entity_id
       and l.attribution_id = r.id
       and l.kind in ('accrual', 'refund_adjustment');
    if v_existing <= 0 then continue; end if;

    -- The rate this order was actually accrued at.
    select l.rate_kind, l.rate_value into v_rate
      from public.affiliate_commission_ledger l
     where l.company_entity_id = v_prog.company_entity_id
       and l.attribution_id = r.id
       and l.kind = 'accrual'
     order by l.created_at desc
     limit 1;
    if v_rate.rate_kind is null then continue; end if;

    v_entitled := case v_rate.rate_kind
      when 'percent_of_net' then round(r.commissionable_cents * coalesce(v_rate.rate_value, 0) / 100.0)::bigint
      when 'fixed_per_order' then case when r.commissionable_cents > 0 then coalesce(v_rate.rate_value, 0)::bigint else 0::bigint end
      else v_existing
    end;
    v_delta := v_entitled - v_existing;
    if v_delta >= 0 then continue; end if;   -- only ever a reduction

    select pr.id into v_period
      from public.affiliate_commission_periods pr
     where pr.company_entity_id = v_prog.company_entity_id
       and pr.program_id = p_program
       and pr.status in ('open', 'under_review')
       and r.order_day between pr.period_start and pr.period_end
     order by pr.period_start desc
     limit 1;

    insert into public.affiliate_commission_ledger (
      company_entity_id, program_id, affiliate_id, period_id, attribution_id,
      kind, amount_cents, currency, rate_kind, rate_value, basis_cents,
      order_id, order_day, source, memo, run_id, created_by
    ) values (
      v_prog.company_entity_id, p_program, r.affiliate_id, v_period, r.id,
      'refund_adjustment', v_delta, v_prog.currency, v_rate.rate_kind, v_rate.rate_value,
      r.commissionable_cents, r.order_id, r.order_day, 'resolver',
      'commissionable base fell to ' || r.commissionable_cents || ' minor units (re-read of a credited order)',
      v_run, null
    );
    v_reduced := v_reduced + 1;
    v_total := v_total + v_delta;
  end loop;

  return jsonb_build_object('program_id', p_program, 'run_id', v_run,
    'orders_changed', v_changed, 'entries_reduced', v_reduced, 'net_amount_cents', v_total);
end;
$$;

comment on function public.affiliate_refresh_credited_orders(uuid) is
  'Re-reads refunds and cancellations on every order a program has credited, at any age and whatever its code''s status now, and accrues the reduction. Never creates credit. Nightly, service role (20261119040000).';

revoke all on function public.affiliate_refresh_credited_orders(uuid) from public, anon, authenticated;
grant execute on function public.affiliate_refresh_credited_orders(uuid) to service_role;
