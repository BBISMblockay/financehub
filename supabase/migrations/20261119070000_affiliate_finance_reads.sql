-- Affiliate Studio: earnings, payouts and PayPal addresses are finance-only reads.
--
-- Pilot check (Blake 2026-11-18): "Check that a regular member can't see
-- finance-only details." Before this, every member of the company could read
-- the commission ledger, payouts, payout lines, PayPal send attempts and each
-- affiliate's PayPal address (each select policy was company_entity_id =
-- active_company_id() alone, read live 2026-11-19). Now those five tables are
-- read only by people who can manage the program (can_manage_affiliate_programs)
-- or approve its money (can_approve_affiliate_commissions), the two gates the
-- module already uses for writing them. The views over them
-- (affiliate_balances_v, affiliate_period_totals_v) are security_invoker, so
-- they follow. Edge functions read with the service role and are unaffected.
-- Attributions and notifications stay company-readable (program activity, not
-- money owed).
do $$
declare t text;
begin
  foreach t in array array['affiliate_commission_ledger', 'affiliate_payouts', 'affiliate_payout_items',
                           'affiliate_payout_sends', 'affiliate_payout_accounts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (company_entity_id = public.active_company_id()
             and (public.can_manage_affiliate_programs() or public.can_approve_affiliate_commissions()))$p$, t || '_select', t);
  end loop;
end $$;
