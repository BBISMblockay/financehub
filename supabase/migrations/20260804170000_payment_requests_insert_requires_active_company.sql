-- ============================================================
-- 20260804170000_payment_requests_insert_requires_active_company.sql
--
-- payment_requests_insert_own had no company check, while
-- payment_request_files_active_insert does (company_entity_id =
-- active_company_id()). A user in the signup->activation window (no
-- membership yet, so active_company_id() is NULL) could therefore insert
-- the parent request -- stamped with a NULL company, invisible to every
-- user in the app -- and then fail on the file rows with "new row
-- violates row-level security policy for table payment_request_files".
-- Each retry minted another invisible ghost request. Caught live
-- 2026-08-04: the first real member-tier user (marketing, new hire)
-- submitted a reimbursement 4 minutes before their membership was
-- granted; 6 ghost rows were cleaned up alongside this fix.
--
-- Requiring company_entity_id = active_company_id() here makes the FIRST
-- insert fail for a not-yet-activated account (immediate, no ghost data)
-- and is a no-op for every activated user: the stamp_company_entity_id
-- trigger fills the column from active_company_id() before RLS's WITH
-- CHECK runs. v2/purchase_request.html additionally shows a plain-language
-- "account not activated yet" message up front so users never reach the
-- RLS error at all.
--
-- Verified under real RLS impersonation: activated member-tier user's
-- request + file insert passes post-migration.
-- ============================================================

drop policy if exists payment_requests_insert_own on public.payment_requests;
create policy payment_requests_insert_own on public.payment_requests for insert to authenticated
  with check (
    auth.uid() is not null
    and company_entity_id = public.active_company_id()
    and (created_by = auth.uid() or created_by is null or public.current_user_can_manage_payment_requests())
  );
