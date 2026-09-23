-- Follow-up to 20260923160000_incoming_shipment_audit.sql (review, PR #768):
--
-- 1. created_by / updated_by now REFERENCE profiles(id). The trigger keeps a
--    value a no-session (service-role) writer supplies, so without a key a
--    typo or stale uuid would be stored as an audit value that can never
--    resolve to a person. Plain references (NO ACTION), like mail_items':
--    ON DELETE SET NULL would fight the trigger -- the SET NULL is itself an
--    UPDATE, and the trigger pins created_by to its old value -- and SILO
--    deactivates people rather than deleting profiles.
-- 2. The Ask SILO / report-builder catalog is refreshed, so a fresh
--    environment or an apply_all run lists the new columns (production was
--    refreshed by hand when 20260923160000 was applied).
--
-- Additive and idempotent. Every existing value is NULL or a real profile
-- (the columns only ever held auth.uid()), so the constraints validate.

do $$
declare
  t text; c text;
begin
  foreach t in array array['incoming_shipments', 'incoming_shipment_lines'] loop
    foreach c in array array['created_by', 'updated_by'] loop
      if not exists (select 1 from pg_constraint
                     where conrelid = ('public.' || t)::regclass and conname = t || '_' || c || '_fkey') then
        execute format('alter table public.%I add constraint %I foreign key (%I) references public.profiles(id)',
                       t, t || '_' || c || '_fkey', c);
      end if;
    end loop;
  end loop;
end $$;

select public.refresh_chat_schema_catalog();
