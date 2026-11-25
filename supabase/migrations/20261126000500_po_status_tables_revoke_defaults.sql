-- 20261126000500: take back what Supabase's default privileges handed out on
-- the two tables 20261125234500 created.
--
-- That migration GRANTED what each role needs and never revoked the rest, so
-- on production `anon` held select/insert/update/delete on both
-- po_status_options and po_status_changes, and `authenticated` held
-- insert/update/delete on po_status_changes -- Supabase re-grants every new
-- public table to anon and authenticated, which is why supabase/CLAUDE.md says
-- to revoke explicitly from BOTH. Nothing leaked: RLS is on, every policy on
-- both tables names `authenticated` only, and there is no INSERT policy on
-- po_status_changes at all, so anon reads nothing and a browser could not add
-- a row. But a grant nobody intended is one policy mistake away from being
-- real, and `verify_v2_schema.sql`'s own "PO step set by AI" check reads
-- CRITICAL until it is gone.
--
-- After this: po_status_options is readable by authenticated (every member)
-- and writable by authenticated under the admin policy, which is what PO
-- Builder and Workspace Settings need; po_status_changes is read-only to
-- authenticated, written only by the definer function that holds the grant's
-- authority. Neither table is reachable by anon or by either integration role,
-- which only ever touch them through those functions.
--
-- Idempotent: revoking a privilege nobody holds is a no-op.

revoke all on public.po_status_options from anon, silo_integration, silo_revoked;
revoke all on public.po_status_changes from anon, silo_integration, silo_revoked;

-- The record of what a connection changed is the person's to READ. It is
-- written by silo_api_set_po_status() as the definer, never by a browser.
revoke insert, update, delete, truncate, references, trigger
  on public.po_status_changes from authenticated;

-- Restate what each role is meant to have, so this file alone describes the
-- end state.
grant select on public.po_status_options to authenticated;
grant insert, update, delete on public.po_status_options to authenticated;
grant select on public.po_status_changes to authenticated;
