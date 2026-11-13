-- 20261113220000_affiliate_seed_sweep_refunds.sql
--
-- Product seeding's nightly sweep (20261113093000), corrected on review:
--
-- 1. Progress never prorates a refund across the cart. Shopify's refunded
--    subtotal is stored per ORDER, so each order counts this product's lines
--    LESS the whole refund (never below 0): exact when the order holds only
--    this product, a lower bound otherwise -- a returned seed product can
--    never count toward its own goal.
-- 2. Before the payback, the seed order is read again: cancelled, or its
--    product wholly refunded, cancels the claim and pays nothing; a partial
--    refund pays back only what is still paid. A seed order not on file that
--    night pays nothing yet.
--
-- Same name, arguments and callers; grants restated below. Idempotent.

create or replace function public.affiliate_seed_sweep(p_program uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     record;
  v_today    date;
  v_c        record;
  v_o        record;
  v_paid     numeric;
  v_minor    integer;
  v_progress bigint;
  v_kept     bigint;
  v_seen     boolean;
  v_ledger   uuid;
  v_bought   integer := 0;
  v_earned   integer := 0;
  v_expired  integer := 0;
begin
  select p.id, p.company_entity_id into v_prog from public.affiliate_programs p where p.id = p_program;
  if not found then
    return jsonb_build_object('error', 'no such program');
  end if;
  v_today := (now() at time zone public.silo_company_timezone(v_prog.company_entity_id))::date;

  -- a. The seed purchase: the first uncancelled order carrying the claim's
  --    code, placed after it was approved. What they PAID for the product is
  --    the basis -- not its list price.
  for v_c in
    select c.* from public.affiliate_seed_claims c
     where c.program_id = p_program and c.company_entity_id = v_prog.company_entity_id
       and c.state in ('approved', 'code_ready') and c.code is not null
     for update
  loop
    select o.order_id, o.order_number, o.currency, o.subtotal_price,
           (o.shopify_created_at at time zone public.silo_company_timezone(o.company_entity_id))::date as order_day
      into v_o
      from public.shopify_orders o
     where o.company_entity_id = v_prog.company_entity_id
       and o.cancelled_at is null
       and o.discount_codes is not null
       and o.shopify_created_at >= coalesce(v_c.decided_at, v_c.requested_at) - interval '1 day'
       and exists (select 1 from jsonb_array_elements_text(o.discount_codes) d(v) where upper(btrim(d.v)) = v_c.code)
       and not exists (select 1 from public.affiliate_seed_claims s
                        where s.company_entity_id = o.company_entity_id and s.seed_order_id = o.order_id)
     order by o.shopify_created_at
     limit 1;
    continue when v_o.order_id is null;

    v_minor := public.affiliate_currency_minor_units(v_o.currency);
    -- The product's own line(s): what the rep paid for THAT item. Never
    -- the order: other things in the same cart are theirs.
    select sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
      into v_paid
      from public.shopify_order_lines l
     where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id
       and lower(btrim(l.title)) = lower(btrim(v_c.product_title));
    -- A product renamed in the shop: the discounted line(s) are the one the
    -- one-product code applied to.
    if v_paid is null then
      select sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
        into v_paid
        from public.shopify_order_lines l
       where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id
         and coalesce(l.discount_allocated, 0) > 0;
    end if;
    -- No line to stand behind: leave it and look again tomorrow.
    continue when v_paid is null;
    v_paid := greatest(v_paid, 0);

    update public.affiliate_seed_claims
       set state = 'purchased', seed_order_id = v_o.order_id, seed_order_number = v_o.order_number,
           seed_order_day = v_o.order_day, currency = upper(v_o.currency),
           seed_paid_cents = round(v_paid * v_minor)::bigint,
           -- Sell the multiple of what they PAID (Blake: a $20 item takes $60 of
           -- sales to get the $20 back).
           goal_cents = round(v_paid * v_minor * v_c.multiple)::bigint,
           goal_by = v_o.order_day + v_c.goal_days
     where id = v_c.id;
    v_bought := v_bought + 1;
  end loop;

  -- b. Progress, then the payback. Sales of THIS product on orders credited
  --    to this affiliate's own code, after the seed order, in its currency,
  --    once the refund window has passed. The seed order itself never counts.
  --    Refunds: Shopify's refunded subtotal is stored per ORDER, not per line,
  --    so each order counts its product lines LESS the whole refund (never
  --    below 0). Exact when the order holds only this product; a lower bound
  --    otherwise -- a refund is never prorated onto another item, so a
  --    refunded seed product can never count toward its own goal.
  for v_c in
    select c.* from public.affiliate_seed_claims c
     where c.program_id = p_program and c.company_entity_id = v_prog.company_entity_id
       and c.state = 'purchased'
     for update
  loop
    v_minor := public.affiliate_currency_minor_units(v_c.currency);
    select coalesce(round(sum(greatest(0, x.product_net - x.refunded)) * v_minor), 0)::bigint
      into v_progress
      from (
        select sum(l.price * l.quantity - coalesce(l.discount_allocated, 0)) as product_net,
               coalesce(o.refunded_subtotal, 0) as refunded
          from public.affiliate_attributions at
          join public.shopify_orders o
            on o.company_entity_id = at.company_entity_id and o.order_id = at.order_id and o.shop_domain = at.shop_domain
          join public.shopify_order_lines l
            on l.company_entity_id = o.company_entity_id and l.order_id = o.order_id and l.shop_domain = o.shop_domain
         where at.company_entity_id = v_c.company_entity_id
           and at.program_id = v_c.program_id
           and at.affiliate_id = v_c.affiliate_id
           and at.basis in ('single_affiliate_code', 'first_affiliate_code')
           and at.order_id <> v_c.seed_order_id
           and at.order_day >= v_c.seed_order_day
           and at.order_day <= least(v_today - v_c.refund_days, v_c.goal_by)
           and o.cancelled_at is null
           and upper(o.currency) = v_c.currency
           and lower(btrim(l.title)) = lower(btrim(v_c.product_title))
         group by o.shop_domain, o.order_id, o.refunded_subtotal
      ) x;

    update public.affiliate_seed_claims
       set progress_cents = v_progress, progress_as_of = now()
     where id = v_c.id;

    -- What the rep still has paid for the product, read from the seed order
    -- NOW: a seed order cancelled or refunded after it was recorded pays back
    -- only what is still paid (the product lines less the order's refund,
    -- the same lower bound as above), and nothing once that is 0.
    select case when o.cancelled_at is not null then 0
                else least(v_c.seed_paid_cents,
                           greatest(0, round((coalesce(
                                sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
                                  filter (where lower(btrim(l.title)) = lower(btrim(v_c.product_title))),
                                sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
                                  filter (where coalesce(l.discount_allocated, 0) > 0), 0)
                              - coalesce(o.refunded_subtotal, 0)) * v_minor))::bigint) end
      into v_kept
      from public.shopify_orders o
      join public.shopify_order_lines l
        on l.company_entity_id = o.company_entity_id and l.order_id = o.order_id and l.shop_domain = o.shop_domain
     where o.company_entity_id = v_c.company_entity_id and o.order_id = v_c.seed_order_id
     group by o.shop_domain, o.order_id, o.cancelled_at, o.refunded_subtotal;
    -- The seed order not on file this run: pay nothing yet (it can still expire).
    v_seen := found;
    -- Cancelled, or its product wholly refunded: nothing to pay back.
    if v_seen and v_kept <= 0 then
      update public.affiliate_seed_claims
         set state = 'cancelled', progress_cents = v_progress, progress_as_of = now()
       where id = v_c.id and state = 'purchased';
      continue;
    end if;

    if v_seen and v_progress >= v_c.goal_cents then
      perform public.affiliate_lock_program_money(v_c.program_id);
      insert into public.affiliate_commission_ledger
        (company_entity_id, program_id, affiliate_id, kind, amount_cents, currency, source, memo)
      -- No order_id and no order_day: it is not an order (so it is not in the
      -- affiliate's order list), and the refund window it would wait out has
      -- already passed for every sale that earned it.
      values (v_c.company_entity_id, v_c.program_id, v_c.affiliate_id, 'manual_adjustment', v_kept,
              v_c.currency, 'manual',
              left('Product seeding paid back: ' || v_c.product_title || ' (claim ' || v_c.id || ')', 500))
      returning id into v_ledger;
      update public.affiliate_seed_claims
         set state = 'earned', earned_at = now(), reimbursement_ledger_id = v_ledger
       where id = v_c.id and state = 'purchased';
      v_earned := v_earned + 1;
    elsif v_today > v_c.goal_by + v_c.refund_days then
      -- The last sale that could count has passed its refund window.
      update public.affiliate_seed_claims set state = 'expired' where id = v_c.id and state = 'purchased';
      v_expired := v_expired + 1;
    end if;
  end loop;

  return jsonb_build_object('purchased', v_bought, 'earned', v_earned, 'expired', v_expired);
end;
$$;

revoke all on function public.affiliate_seed_sweep(uuid) from public, anon, authenticated;
grant execute on function public.affiliate_seed_sweep(uuid) to service_role;

comment on function public.affiliate_seed_sweep(uuid) is
  'Product seeding, for one program: records each approved claim''s seed purchase (first order carrying its code), measures progress (that product''s sales on the affiliate''s own credited orders after the seed order, refund window passed, net of refunds), writes the payback ONCE as a manual_adjustment ledger line when the goal is met, and expires claims past their goal date. Service role only; run after commissions accrue. 20261113093000, refunds corrected 20261113220000.';
