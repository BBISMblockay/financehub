-- 20261125233000: the customer-find tables get the guards every other
-- affiliate table has, and two trigger functions lose their client grants.
--
-- Found by the drift check (verify_v2_schema.sql #212, #352, #357), red since
-- 20261124170000 / 20261121230000 / 20261124000000 merged:
--   * affiliate_customer_scans.program_id, affiliate_customer_social.program_id
--     and affiliate_customer_social.scan_id had no same-company twin, so a
--     definer path could point a row at another company's program or scan.
--   * neither table had the three program-scope statement triggers, so a
--     scoped manager calling a definer RPC was not held to their programs.
--   * affiliate_payout_account_mirror() and affiliate_person_email_follows()
--     kept Supabase's default EXECUTE for anon and authenticated.
--
-- Both sweeps already exist and are idempotent; this file only runs them.
-- Production rows were checked before writing this: no cross-company
-- reference exists, so the new foreign keys validate. If one ever did, the
-- whole file rolls back and nothing changes.

select public.attach_affiliate_same_company_twins();
select public.attach_affiliate_program_scope_triggers();

-- Trigger functions: a trigger fires regardless of EXECUTE, so nothing that
-- works today needs these grants.
revoke all on function public.affiliate_payout_account_mirror() from public, anon, authenticated;
revoke all on function public.affiliate_person_email_follows() from public, anon, authenticated;
