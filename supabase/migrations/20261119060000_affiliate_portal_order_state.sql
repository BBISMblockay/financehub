-- Affiliate portal: why an order's earnings are pending, approved or paid.
--
-- Blake 2026-11-18: "From the affiliate side, make it obvious ... why
-- earnings are pending, approved, or paid." affiliate_portal_orders already
-- returned what each order earned and what was paid. It now also returns:
--   * approved_cents -- the part that sits in a payout the brand approved
--     (approved or exported) but has not marked paid yet;
--   * payable_from   -- the day the order's refund hold ends (order day plus
--     the program's refund_hold_days), the same rule payout building uses
--     (20261110085000: positive entries wait until order_day + hold <= through).
-- The body is the live production definition, read 2026-11-19, with only
-- those two fields added. Same signature, so grants are kept (service role
-- only: the portal function calls it with the affiliate's token hash).
create or replace function public.affiliate_portal_orders(p_token_hash text, p_limit integer default 50, p_offset integer default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tok   record;
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now();
  if not found or v_tok.affiliate_id is null then
    raise exception 'affiliate_portal_orders: link is not valid' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'limit', v_lim,
    'offset', v_off,
    'total', (
      select count(distinct l.order_id)
        from public.affiliate_commission_ledger l
       where l.company_entity_id = v_tok.company_entity_id
         and l.affiliate_id = v_tok.affiliate_id
         and l.order_id is not null),
    'orders', (
      select coalesce(jsonb_agg(o order by o->>'sort_day' desc nulls last, o->>'order_id'), '[]'::jsonb)
        from (
          select jsonb_build_object(
                   'order_id', g.order_id,
                   'order_number', g.order_number,
                   'order_day', g.order_day,
                   'sort_day', g.order_day,
                   'order_value_cents', g.basis_cents,
                   'earned_cents', g.earned_cents,
                   'code', g.code,
                   'paid_cents', g.paid_cents,
                   'approved_cents', g.approved_cents,
                   'payable_from', g.payable_from,
                   'entries', g.entries) as o
            from (
              select l.order_id,
                     max(l.order_day) as order_day,
                     max(a.order_number) as order_number,
                     max(a.matched_code) as code,
                     max(l.basis_cents) filter (where l.kind = 'accrual') as basis_cents,
                     sum(l.amount_cents) as earned_cents,
                     coalesce(sum(l.amount_cents) filter (
                       where exists (select 1 from public.affiliate_payout_items i
                                      join public.affiliate_payouts po on po.id = i.payout_id and po.status = 'marked_paid'
                                     where i.ledger_entry_id = l.id)), 0) as paid_cents,
                     coalesce(sum(l.amount_cents) filter (
                       where exists (select 1 from public.affiliate_payout_items i
                                      join public.affiliate_payouts po on po.id = i.payout_id and po.status in ('approved', 'exported')
                                     where i.ledger_entry_id = l.id)), 0) as approved_cents,
                     (max(l.order_day) + max(p.refund_hold_days)) as payable_from,
                     jsonb_agg(jsonb_build_object(
                       'kind', l.kind, 'amount_cents', l.amount_cents, 'memo', l.memo,
                       'rate_kind', l.rate_kind, 'rate_value', l.rate_value,
                       'basis_cents', l.basis_cents, 'created_at', l.created_at)
                       order by l.created_at) as entries
                from public.affiliate_commission_ledger l
                left join public.affiliate_attributions a on a.id = l.attribution_id
                left join public.affiliate_programs p on p.id = l.program_id and p.company_entity_id = l.company_entity_id
               where l.company_entity_id = v_tok.company_entity_id
                 and l.affiliate_id = v_tok.affiliate_id
                 and l.order_id is not null
               group by l.order_id
               order by max(l.order_day) desc nulls last, l.order_id
               limit v_lim offset v_off) g) q));
end;
$function$;
revoke all on function public.affiliate_portal_orders(text, integer, integer) from public, anon, authenticated;
grant execute on function public.affiliate_portal_orders(text, integer, integer) to service_role;
