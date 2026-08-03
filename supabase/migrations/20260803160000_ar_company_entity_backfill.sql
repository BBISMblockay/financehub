-- ============================================================
-- 20260803160000_ar_company_entity_backfill.sql
-- AR sheet-sync rows inserted after the 2026-06 multi-tenant backfill were
-- never stamped with company_entity_id (the sync writes as service_role and
-- the tables have no default/trigger), so RLS hid every order after Jun 12
-- from the receivables workbench while the sync kept reporting success.
-- The sync now stamps explicitly (server/ar-sync.mjs); this backfills the
-- rows created in between. Idempotent — safe to re-run.
-- ============================================================

update public.ar_invoices i
set company_entity_id = e.id
from public.entities e
where e.entity_type = 'company'
  and e.entity_key = 'baseballism'
  and i.company_entity_id is null;

update public.ar_customers c
set company_entity_id = e.id
from public.entities e
where e.entity_type = 'company'
  and e.entity_key = 'baseballism'
  and c.company_entity_id is null;
