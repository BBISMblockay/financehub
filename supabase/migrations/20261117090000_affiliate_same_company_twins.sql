-- 20261117090000_affiliate_same_company_twins.sql
--
-- Every Affiliate Studio reference to another Affiliate Studio row carries a
-- same-company twin: a two-column foreign key (x_id, company_entity_id) next to
-- the plain one, so a row can never point at another company's program,
-- affiliate, ledger line or payout. verify_v2_schema.sql ("Affiliate Studio")
-- checks this by structure. Four references shipped without one:
--   * affiliate_content_submissions.program_id, .affiliate_id and
--     .bonus_ledger_id (20261117050000_affiliate_content.sql);
--   * affiliate_notifications.payout_id (20261117040000).
-- Production had no row that breaks the rule when this was written (checked
-- 2026-11-17: 0 content rows, 0 notifications pointing at another company's
-- payout). Additive and idempotent; the parents already carry the
-- (id, company_entity_id) unique keys these reference.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_content_submissions_program_id_same_co'
                   and conrelid = 'public.affiliate_content_submissions'::regclass) then
    alter table public.affiliate_content_submissions
      add constraint affiliate_content_submissions_program_id_same_co
      foreign key (program_id, company_entity_id) references public.affiliate_programs (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_content_submissions_affiliate_id_same_co'
                   and conrelid = 'public.affiliate_content_submissions'::regclass) then
    alter table public.affiliate_content_submissions
      add constraint affiliate_content_submissions_affiliate_id_same_co
      foreign key (affiliate_id, company_entity_id) references public.affiliates (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_content_submissions_bonus_ledger_id_same_co'
                   and conrelid = 'public.affiliate_content_submissions'::regclass) then
    alter table public.affiliate_content_submissions
      add constraint affiliate_content_submissions_bonus_ledger_id_same_co
      foreign key (bonus_ledger_id, company_entity_id) references public.affiliate_commission_ledger (id, company_entity_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_notifications_payout_id_same_co'
                   and conrelid = 'public.affiliate_notifications'::regclass) then
    alter table public.affiliate_notifications
      add constraint affiliate_notifications_payout_id_same_co
      foreign key (payout_id, company_entity_id) references public.affiliate_payouts (id, company_entity_id);
  end if;
end $$;
