-- Launch form: an intentional "products not known yet" state.
--
-- A launch is measured only through what is attached to it -- a linked PO
-- (launch_actuals_v) or products in its Products tab (launch_product_actuals_v).
-- Launches overlap heavily, so a date window cannot separate them, and a link
-- nobody recorded at the time cannot be reconstructed: 43 of 61 launches were
-- unmeasurable for that reason. /v2/launch-calendar.html now refuses to save a
-- launch with no link until the person either commits to attaching products
-- or says they are not known yet. The second answer is recorded here so it
-- stays visible for follow-up, instead of reading the same as nobody asking.
--
-- Additive. No policy change: launch_calendar's existing RLS governs these
-- columns like every other. Nothing reads them to estimate a result, and
-- launch_measurability_v / launch_actuals_v / launch_product_actuals_v are
-- untouched -- the measurement rules do not change.

alter table public.launch_calendar
  add column if not exists products_unknown_at   timestamptz,
  add column if not exists products_unknown_by   uuid,
  add column if not exists products_unknown_note text;

comment on column public.launch_calendar.products_unknown_at is
  'When someone marked this launch "products not known yet" in the launch form. NULL = not deferred. It is a follow-up flag, not a measurement: a launch with this set is unmeasurable. Cleared by trigger the moment a PO is linked or a launch_product_readiness row is attached, by any writer; removing products later does not restore it.';
comment on column public.launch_calendar.products_unknown_by is
  'Who marked products as not known yet. Stamped from auth.uid() by trg_launch_products_unknown, never taken from the client.';
comment on column public.launch_calendar.products_unknown_note is
  'Optional note on what is missing or who will attach the products.';

-- By/note only mean something while the flag is set. The trigger below keeps
-- that true for app writes; the CHECK keeps it true for any other writer.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'launch_calendar_products_unknown_consistent'
                   and conrelid = 'public.launch_calendar'::regclass) then
    alter table public.launch_calendar
      add constraint launch_calendar_products_unknown_consistent
      check (products_unknown_at is not null
             or (products_unknown_by is null and products_unknown_note is null));
  end if;
end $$;

-- SECURITY INVOKER: it only rewrites NEW. `by` is the caller at the moment the
-- flag is first set and is kept on later edits (the follow-up's owner does not
-- move because somebody fixed a typo in the note).
--
-- The flag means "nothing is linked YET", so it cannot outlive a link. A row
-- that has a PO, or has products attached, drops the flag here whoever wrote
-- it -- the launch form, the drawer's Products tab, another page, a script.
-- Holding that in the form alone left the drawer's product-add paths keeping
-- a stale flag, which a later product removal would resurrect with its old
-- date and note (independent review, cycle 1). Clearing rather than raising:
-- a person who marked "not known yet" in a form opened before a colleague
-- attached a product should not have their whole save refused.
create or replace function public.stamp_launch_products_unknown()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.products_unknown_at is not null and (
       new.linked_po_id is not null
       or exists (select 1 from public.launch_product_readiness r where r.launch_id = new.id)) then
    new.products_unknown_at := null;
  end if;
  if new.products_unknown_at is null then
    new.products_unknown_by   := null;
    new.products_unknown_note := null;
  elsif tg_op = 'INSERT' or old.products_unknown_at is null then
    new.products_unknown_by := auth.uid();
  else
    new.products_unknown_by := old.products_unknown_by;
  end if;
  return new;
end $$;

revoke all on function public.stamp_launch_products_unknown() from public, anon, authenticated;

drop trigger if exists trg_launch_products_unknown on public.launch_calendar;
create trigger trg_launch_products_unknown
  before insert or update of products_unknown_at, products_unknown_by, products_unknown_note, linked_po_id
  on public.launch_calendar
  for each row execute function public.stamp_launch_products_unknown();

-- The other half: attaching a product to a flagged launch clears the flag on
-- the launch, in the SAME transaction as the attach. There is no separate
-- client call that can fail after the product lands, so "attached but still
-- flagged" is not a state anything can leave behind. INVOKER on purpose: both
-- tables carry the identical write policy (company_entity_id =
-- active_company_id()), so whoever may attach a product may clear the flag,
-- and a launch in another company is simply not updated. Removing the last
-- product does NOT restore the flag -- the launch then reads "No products or
-- PO", which is the truth, rather than a follow-up with a stale date and note.
create or replace function public.clear_launch_products_unknown_on_attach()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.launch_calendar
     set products_unknown_at = null
   where id = new.launch_id
     and products_unknown_at is not null;
  return null;
end $$;

revoke all on function public.clear_launch_products_unknown_on_attach() from public, anon, authenticated;

drop trigger if exists trg_launch_products_unknown_clear on public.launch_product_readiness;
create trigger trg_launch_products_unknown_clear
  after insert or update of launch_id
  on public.launch_product_readiness
  for each row execute function public.clear_launch_products_unknown_on_attach();

select public.refresh_chat_schema_catalog();
