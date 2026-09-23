-- Who created and who last changed a PO Report shipment.
--
-- incoming_shipments / incoming_shipment_lines carried only created_at and
-- updated_at, so "who is managing shipments" had no answer: ten shipments and
-- 95 lines were being maintained (last edit 2026-09-23) with no person on any
-- of them. This adds created_by / updated_by to both tables, stamped by the
-- database from the signed-in session -- the page does not change and cannot
-- get it wrong.
--
-- Stamped, not trusted:
--   * INSERT: created_by and updated_by are the caller (auth.uid()). A value
--     the client sends is kept only when there is no session (service role /
--     SQL editor), so a browser cannot attribute a row to someone else.
--     (The older stamp_created_by only fills a NULL; that is fine for
--     "who submitted" but not for an audit column.)
--   * UPDATE: created_by can never change; updated_by is the caller, or NULL
--     for a write with no session -- NULL means "a system write", never
--     "whoever touched it last before".
-- Rows written before this migration stay NULL: unattributed, not unknown
-- by accident -- there is no record to recover them from.
-- Deletes are not recorded: a deleted shipment or line leaves no row.

alter table public.incoming_shipments
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
alter table public.incoming_shipment_lines
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;

comment on column public.incoming_shipments.created_by is 'profiles.id of the person who created the shipment (stamped from the session; NULL = before 2026-09-23 or a system write)';
comment on column public.incoming_shipments.updated_by is 'profiles.id of the person who last changed the shipment (stamped from the session; NULL = never changed since 2026-09-23, or last changed by a system write)';
comment on column public.incoming_shipment_lines.created_by is 'profiles.id of the person who added the line (stamped from the session; NULL = before 2026-09-23 or a system write)';
comment on column public.incoming_shipment_lines.updated_by is 'profiles.id of the person who last changed the line (stamped from the session; NULL = never changed since 2026-09-23, or last changed by a system write)';

create or replace function public.stamp_shipment_audit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
      new.updated_by := auth.uid();
    end if;
  else
    new.created_by := old.created_by;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;
-- A trigger function; nobody calls it directly.
revoke all on function public.stamp_shipment_audit() from public, anon, authenticated;

drop trigger if exists trg_incoming_shipments_audit on public.incoming_shipments;
create trigger trg_incoming_shipments_audit
  before insert or update on public.incoming_shipments
  for each row execute function public.stamp_shipment_audit();

drop trigger if exists trg_incoming_shipment_lines_audit on public.incoming_shipment_lines;
create trigger trg_incoming_shipment_lines_audit
  before insert or update on public.incoming_shipment_lines
  for each row execute function public.stamp_shipment_audit();
