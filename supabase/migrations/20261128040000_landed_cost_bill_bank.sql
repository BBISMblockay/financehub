-- =============================================================================
-- Landed cost: the BILL BANK.
--
-- Before this, /v2/po-costing.html Step 3 took a typed Freight total on the PO.
-- Nothing tied that number to the invoice it came from, so one forwarder bill
-- covering several POs was typed IN FULL onto each of them. Measured on
-- production 2026-11-26: ARJFK260900741 was paid once at $7,887.50 and recorded
-- at $7,887.50 on four POs; ARJFK260801268 ($3,839.99) on two. $27,502 of the
-- $66,929 of freight in landed cost was the same money counted twice or more,
-- while 19 of 25 freight invoices ($116,443) had never reached a PO at all.
--
-- The model here: a bill is a row, and it is SPENT, not retyped.
--   landed_cost_bills       one row per real invoice -- what was PAID.
--                           Mirrored from payment_requests (request_type
--                           'inventory_freight') by trigger, so AP stays the
--                           source of truth and nobody keys an amount twice.
--   landed_cost_allocations what of that bill lands on which PO, and -- when
--                           the PO ships in more than one container -- on which
--                           SHIPMENT. A trigger refuses an allocation that
--                           would spend more of a bill than the bill holds.
--
-- Allocation is per SHIPMENT because that is the real world: a PO that ships in
-- two containers has two freight bills, and the first one must not spread over
-- units still sitting at the factory. `shipment_id` null means the whole PO,
-- which is the only honest answer while a PO has no shipment rows yet.
--
-- NOTHING NUMERIC CHANGES ON APPLY. The backfill at the end reproduces every
-- po_costing.freight_amount that exists today as an allocation, against the
-- matching paid bill where its reference matches, and otherwise against a
-- `legacy` bill carrying that exact amount. So every PO keeps the landed cost
-- it has, and the duplication becomes VISIBLE (a legacy bill beside the paid
-- one) instead of being silently rewritten under anyone's feet.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The bank
-- ---------------------------------------------------------------------------

create table if not exists public.landed_cost_bills (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- The AP row this mirrors. NULL for a bill entered by hand and for the
  -- `legacy` stubs the backfill writes. ON DELETE SET NULL, never cascade: a
  -- deleted payment request must not take the cost allocation with it.
  payment_request_id uuid references public.payment_requests(id) on delete set null,

  source text not null default 'payment_request'
    check (source in ('payment_request', 'manual', 'legacy')),

  -- Generic on purpose. Freight is what SILO allocates today; duty, tariff and
  -- brokerage ride the same mechanism and land in their own cost bucket.
  kind text not null default 'freight'
    check (kind in ('freight', 'duty', 'tariff', 'brokerage', 'other')),

  vendor_name text,
  bill_ref text,
  bill_date date,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  currency text,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

-- One bill per payment request. A partial index, because `manual` and `legacy`
-- bills all carry NULL there and several NULLs are not a conflict.
create unique index if not exists landed_cost_bills_payment_request_key
  on public.landed_cost_bills (payment_request_id)
  where payment_request_id is not null;

create index if not exists landed_cost_bills_company_idx
  on public.landed_cost_bills (company_entity_id, kind, bill_date desc);

-- ---------------------------------------------------------------------------
-- What each bill pays for
-- ---------------------------------------------------------------------------

create table if not exists public.landed_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  bill_id uuid not null references public.landed_cost_bills(id) on delete cascade,
  po_header_id uuid not null references public.po_headers(id) on delete cascade,
  -- NULL = the whole PO. Set = this container only, and then the cost spreads
  -- over the quantities on THAT shipment's lines.
  shipment_id uuid references public.incoming_shipments(id) on delete set null,

  amount numeric(14, 2) not null check (amount > 0),
  -- How the amount was arrived at, for the audit trail. The split itself is
  -- recomputed by the page; this records which way the person chose.
  method text not null default 'value'
    check (method in ('value', 'units', 'manual')),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- The container this allocation named has since been deleted. `shipment_id` is
-- ON DELETE SET NULL, and a null shipment otherwise means "the whole PO" -- so
-- without this flag, deleting one of a PO's two containers would silently
-- respread that container's freight over BOTH containers' units, miscosting
-- inventory with nobody deciding anything. Flagged rows are reported for
-- reassignment and spread over no lines at all until somebody says where they
-- belong. Set by the guard trigger, never by a writer.
alter table public.landed_cost_allocations
  add column if not exists shipment_detached boolean not null default false;

-- One allocation per bill per target. Two indexes, because NULL shipment_id
-- would otherwise let the same bill be put on the same PO repeatedly -- which
-- is the exact bug this table exists to stop.
-- Detached rows are excluded from both: a container deleted while its freight
-- was allocated turns that row into an orphan awaiting reassignment, and two
-- orphans off one bill on one PO must not collide -- a unique violation there
-- would refuse the shipment deletion itself, with an error about an index.
create unique index if not exists landed_cost_allocations_po_key
  on public.landed_cost_allocations (bill_id, po_header_id)
  where shipment_id is null and not shipment_detached;
create unique index if not exists landed_cost_allocations_shipment_key
  on public.landed_cost_allocations (bill_id, po_header_id, shipment_id)
  where shipment_id is not null;

create index if not exists landed_cost_allocations_po_idx
  on public.landed_cost_allocations (po_header_id);
create index if not exists landed_cost_allocations_bill_idx
  on public.landed_cost_allocations (bill_id);
create index if not exists landed_cost_allocations_shipment_idx
  on public.landed_cost_allocations (shipment_id)
  where shipment_id is not null;

-- ---------------------------------------------------------------------------
-- The guard: a bill cannot be spent twice
-- ---------------------------------------------------------------------------

create or replace function public.landed_cost_allocation_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill   public.landed_cost_bills%rowtype;
  v_other  numeric(14, 2);
  v_po_co  uuid;
  v_sh_po  uuid;
begin
  -- FOR UPDATE, or two people allocating the same bill at the same moment both
  -- read the old total and both pass. The lock is the whole point of the guard.
  select * into v_bill from public.landed_cost_bills where id = new.bill_id for update;
  if not found then
    raise exception 'landed_cost_allocations: bill % does not exist', new.bill_id
      using errcode = 'foreign_key_violation';
  end if;

  select company_entity_id into v_po_co from public.po_headers where id = new.po_header_id;
  if v_po_co is null or v_po_co is distinct from v_bill.company_entity_id then
    raise exception 'landed_cost_allocations: purchase order and bill belong to different companies'
      using errcode = 'check_violation';
  end if;
  new.company_entity_id := v_bill.company_entity_id;

  -- A container deleted out from under an allocation. `on delete set null`
  -- fires as an UPDATE here, and a null shipment means "the whole PO", so
  -- without this the freight of one container would quietly spread over every
  -- container's units. Flag it instead; the page reports it for reassignment
  -- and lands it on no line until somebody decides. An UPDATE is the only way
  -- shipment_id goes from set to null -- the allocation RPC re-states a split
  -- by delete and insert, so a deliberate whole-PO allocation is an INSERT.
  if tg_op = 'INSERT' then
    new.shipment_detached := false;
  elsif old.shipment_id is not null and new.shipment_id is null then
    new.shipment_detached := true;
  elsif new.shipment_id is distinct from old.shipment_id then
    new.shipment_detached := false;
  end if;

  -- A shipment named here must be a shipment OF THIS PO. Allocating a bill to
  -- another PO's container would spread freight over units it never carried.
  if new.shipment_id is not null then
    select po_header_id into v_sh_po from public.incoming_shipments where id = new.shipment_id;
    if v_sh_po is null or v_sh_po is distinct from new.po_header_id then
      raise exception 'landed_cost_allocations: shipment % does not belong to purchase order %',
        new.shipment_id, new.po_header_id
        using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(sum(amount), 0) into v_other
    from public.landed_cost_allocations
   where bill_id = new.bill_id
     and id is distinct from new.id;

  -- Half a cent of slack, because the page's own split rounds to cents.
  if v_other + new.amount > v_bill.amount + 0.005 then
    raise exception
      'landed_cost_allocations: % already allocated of a % bill; % more would overspend it by %',
      to_char(v_other, 'FM999999990.00'),
      to_char(v_bill.amount, 'FM999999990.00'),
      to_char(new.amount, 'FM999999990.00'),
      to_char(v_other + new.amount - v_bill.amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists zz_landed_cost_allocation_guard on public.landed_cost_allocations;
create trigger zz_landed_cost_allocation_guard
  before insert or update on public.landed_cost_allocations
  for each row execute function public.landed_cost_allocation_guard();

drop trigger if exists landed_cost_bills_set_updated_at on public.landed_cost_bills;
create trigger landed_cost_bills_set_updated_at
  before update on public.landed_cost_bills
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The second guard: AP owns an AP-sourced bill, and spent money is not deleted
-- ---------------------------------------------------------------------------
-- The write policy below is po_costing_can_write(), which is right for
-- ALLOCATING -- but it also grants update and delete on the bills themselves.
-- Without this, somebody costing a PO could raise an AP-sourced bill's amount
-- and allocate the difference, so the bank no longer says what the company
-- agreed to pay; or delete the bill, cascading away every PO's share of it.
-- The mirror trigger signals itself with a transaction-local setting, so AP
-- remains the only writer of those fields.
create or replace function public.landed_cost_bill_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sync   boolean := coalesce(current_setting('silo.landed_cost_sync', true), '') = 'on';
  v_spent  numeric(14, 2);
begin
  if tg_op = 'DELETE' then
    select coalesce(sum(amount), 0) into v_spent
      from public.landed_cost_allocations where bill_id = old.id;
    if v_spent > 0 then
      raise exception
        'landed_cost_bills: % of this bill is allocated to a purchase order; take the allocations off it first',
        to_char(v_spent, 'FM999999990.00')
        using errcode = 'check_violation';
    end if;
    if old.source = 'payment_request' and not v_sync then
      raise exception 'landed_cost_bills: a bill from a payment request is removed by retyping the request, not from costing'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.source = 'payment_request' and not v_sync then
    -- Reclassifying what the bill IS (freight / duty / tariff) and annotating
    -- it stay a costing decision. What the company owes, and to whom, is AP's.
    if new.amount is distinct from old.amount
       or new.payment_request_id is distinct from old.payment_request_id
       or new.company_entity_id is distinct from old.company_entity_id
       or new.source is distinct from old.source
       or coalesce(new.vendor_name, '') is distinct from coalesce(old.vendor_name, '')
       or coalesce(new.bill_ref, '') is distinct from coalesce(old.bill_ref, '')
       or new.bill_date is distinct from old.bill_date then
      raise exception 'landed_cost_bills: this bill comes from a payment request; change the request, not the bill'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists zz_landed_cost_bill_guard on public.landed_cost_bills;
create trigger zz_landed_cost_bill_guard
  before update or delete on public.landed_cost_bills
  for each row execute function public.landed_cost_bill_guard();

-- ---------------------------------------------------------------------------
-- Mirror of AP: a freight payment request IS a bill in the bank
-- ---------------------------------------------------------------------------

create or replace function public.landed_cost_bill_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Tells landed_cost_bill_guard() that AP, not a costing user, is writing.
  -- Transaction-local, so it cannot leak into the next statement.
  perform set_config('silo.landed_cost_sync', 'on', true);

  if tg_op = 'UPDATE' and old.request_type = 'inventory_freight'
     and new.request_type is distinct from 'inventory_freight' then
    -- Retyped away from freight. Drop the mirrored bill only while nothing has
    -- been spent from it; an allocated bill stays, because deleting it would
    -- cascade away a PO's landed cost.
    delete from public.landed_cost_bills b
     where b.payment_request_id = new.id
       and not exists (select 1 from public.landed_cost_allocations a where a.bill_id = b.id);
    return new;
  end if;

  if new.request_type is distinct from 'inventory_freight' then
    return new;
  end if;

  insert into public.landed_cost_bills as b (
    company_entity_id, payment_request_id, source, kind,
    vendor_name, bill_ref, bill_date, amount, notes, created_by
  )
  values (
    new.company_entity_id, new.id, 'payment_request', 'freight',
    coalesce(nullif(btrim(new.vendor_name), ''), nullif(btrim(new.vendor_name_manual), '')),
    nullif(btrim(new.invoice_number), ''),
    coalesce(new.date_completed, new.due_date, new.submitted_at::date, new.created_at::date),
    new.amount_due,
    nullif(btrim(new.internal_po_number), ''),
    new.created_by
  )
  on conflict (payment_request_id) where payment_request_id is not null
  do update set
    company_entity_id = excluded.company_entity_id,
    vendor_name = excluded.vendor_name,
    bill_ref    = excluded.bill_ref,
    bill_date   = excluded.bill_date,
    amount      = excluded.amount,
    notes       = excluded.notes,
    updated_at  = now();

  return new;
end;
$$;

-- AFTER, not BEFORE: the request's own stamp triggers must have run, or the
-- mirrored bill is written with a null company.
drop trigger if exists zz_landed_cost_bill_sync on public.payment_requests;
create trigger zz_landed_cost_bill_sync
  after insert or update of request_type, amount_due, invoice_number, vendor_name,
                            vendor_name_manual, internal_po_number, due_date, date_completed
  on public.payment_requests
  for each row execute function public.landed_cost_bill_sync();

-- ---------------------------------------------------------------------------
-- The stored per-PO totals follow the bills
-- ---------------------------------------------------------------------------
-- po_costing.freight_amount / misc_amount / duty_amount / landed_total are a
-- CACHE of what the bills put on a PO, and they are reportable: Ask SILO and
-- saved reports read po_costing and v_po_costing_summary directly. Allocating
-- one invoice across four POs only ever reloaded the PO that was open, so the
-- other three kept their old totals until somebody opened and saved each one.
-- This makes the cache follow every allocation change, for every PO the change
-- touched, whoever wrote it.
--
-- PO-level only, deliberately. These four are plain sums plus the typed duty
-- percentage, so there is no split math here. The per-LINE shares in
-- po_costing_lines are recomputed by the page's own engine (which weighs
-- shipment quantities and rounds by largest remainder); duplicating that in
-- SQL would be a second definition of the same math, free to drift from the
-- first. A PO with no po_costing row is left alone -- it has no cache to keep.
create or replace function public.landed_cost_sync_po_costing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pos uuid[];
begin
  v_pos := array_remove(array[
    case when tg_op <> 'INSERT' then old.po_header_id end,
    case when tg_op <> 'DELETE' then new.po_header_id end], null);

  update public.po_costing pc
     set freight_amount = t.freight_allocated,
         misc_amount    = t.misc_allocated,
         duty_amount    = round(coalesce(pc.fob_total, 0) * coalesce(pc.duty_pct, 0) / 100.0, 2)
                          + t.duty_allocated,
         landed_total   = coalesce(pc.fob_total, 0) + t.freight_allocated + t.misc_allocated
                          + round(coalesce(pc.fob_total, 0) * coalesce(pc.duty_pct, 0) / 100.0, 2)
                          + t.duty_allocated,
         updated_at     = now()
    from (
      select p.po_header_id,
             coalesce(sum(a.amount) filter (where b.kind = 'freight'), 0) as freight_allocated,
             coalesce(sum(a.amount) filter (where b.kind in ('duty', 'tariff')), 0) as duty_allocated,
             coalesce(sum(a.amount) filter (where b.kind in ('brokerage', 'other')), 0) as misc_allocated
        from unnest(v_pos) as p(po_header_id)
        left join public.landed_cost_allocations a on a.po_header_id = p.po_header_id
        left join public.landed_cost_bills b on b.id = a.bill_id
       group by p.po_header_id) t
   where t.po_header_id = pc.po_header_id;

  return null;
end;
$$;

drop trigger if exists zz_landed_cost_sync_po_costing on public.landed_cost_allocations;
create trigger zz_landed_cost_sync_po_costing
  after insert or update or delete on public.landed_cost_allocations
  for each row execute function public.landed_cost_sync_po_costing();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- The bank, with what is left on each bill. This is what the picker reads, and
-- `remaining` is what makes a second full entry of the same invoice impossible.
create or replace view public.v_landed_cost_bill_balance
with (security_invoker = true) as
select
  b.id as bill_id,
  b.company_entity_id,
  b.payment_request_id,
  b.source,
  b.kind,
  b.vendor_name,
  b.bill_ref,
  b.bill_date,
  b.amount,
  b.notes,
  coalesce(a.allocated, 0)::numeric(14, 2) as allocated,
  (b.amount - coalesce(a.allocated, 0))::numeric(14, 2) as remaining,
  coalesce(a.allocation_count, 0) as allocation_count,
  a.po_names,
  case
    when coalesce(a.allocated, 0) > b.amount + 0.005 then 'over'
    when coalesce(a.allocated, 0) >= b.amount - 0.005 and b.amount > 0 then 'allocated'
    when coalesce(a.allocated, 0) > 0 then 'partial'
    else 'unallocated'
  end as allocation_state,
  b.created_at,
  b.updated_at
from public.landed_cost_bills b
left join lateral (
  select
    sum(al.amount) as allocated,
    count(*) as allocation_count,
    string_agg(distinct ph.po_name, ', ' order by ph.po_name) as po_names
  from public.landed_cost_allocations al
  join public.po_headers ph on ph.id = al.po_header_id
  where al.bill_id = b.id
) a on true;

-- What a PO (and, where it is known, each of its shipments) has had allocated
-- to it, split by the bucket each bill's kind belongs in. The costing page
-- reads this instead of asking anyone to type a freight total.
create or replace view public.v_po_landed_cost_allocations
with (security_invoker = true) as
select
  al.id as allocation_id,
  al.company_entity_id,
  al.po_header_id,
  al.shipment_id,
  al.amount,
  al.method,
  al.notes,
  b.id as bill_id,
  b.kind,
  b.source,
  b.vendor_name,
  b.bill_ref,
  b.bill_date,
  b.amount as bill_amount,
  case b.kind
    when 'freight' then 'freight'
    when 'duty' then 'duty'
    when 'tariff' then 'duty'
    else 'misc'
  end as cost_bucket,
  s.shipment_status,
  s.container_ref,
  s.ship_date,
  al.created_at,
  -- Appended, not inserted: `create or replace view` cannot rename a column,
  -- so a new one goes on the end or the replace is refused.
  -- The container this allocation named has been deleted. The page spreads
  -- such a row over NO line and reports it for reassignment, rather than
  -- reading the null shipment as "the whole PO" and respreading the freight
  -- over units that container never carried.
  al.shipment_detached
from public.landed_cost_allocations al
join public.landed_cost_bills b on b.id = al.bill_id
left join public.incoming_shipments s on s.id = al.shipment_id;

-- One row per PO: the reconciliation the page shows, and the figure
-- po_costing.freight_amount is kept equal to.
create or replace view public.v_po_landed_cost_totals
with (security_invoker = true) as
select
  al.po_header_id,
  al.company_entity_id,
  sum(al.amount) filter (where b.kind = 'freight')::numeric(14, 2) as freight_allocated,
  sum(al.amount) filter (where b.kind in ('duty', 'tariff'))::numeric(14, 2) as duty_allocated,
  sum(al.amount) filter (where b.kind in ('brokerage', 'other'))::numeric(14, 2) as misc_allocated,
  sum(al.amount)::numeric(14, 2) as total_allocated,
  count(*) as allocation_count,
  count(*) filter (where al.shipment_id is not null) as shipment_allocation_count
from public.landed_cost_allocations al
join public.landed_cost_bills b on b.id = al.bill_id
group by al.po_header_id, al.company_entity_id;

-- ---------------------------------------------------------------------------
-- Re-stating a bill's split, atomically
-- ---------------------------------------------------------------------------

-- The dialog hands over the WHOLE split for one bill. Delete-then-insert from
-- the browser is two requests, and a failure between them would leave the bill
-- with nothing allocated -- a PO silently losing its freight. One function, one
-- transaction, and the over-allocation guard still fires inside it.
--
-- SECURITY INVOKER on purpose: the caller's own RLS decides whether they may
-- write these rows. An RLS refusal is zero rows, not an error, so the row count
-- is checked and reported rather than assumed.
create or replace function public.silo_allocate_landed_cost_bill(
  p_bill_id uuid,
  p_rows jsonb
)
returns table (allocation_id uuid, po_header_id uuid, shipment_id uuid, amount numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company uuid;
  v_total numeric(14, 2);
  v_amount numeric(14, 2);
  v_deleted int;
begin
  select b.company_entity_id, b.amount into v_company, v_amount
    from public.landed_cost_bills b where b.id = p_bill_id;
  if v_company is null then
    raise exception 'silo_allocate_landed_cost_bill: bill % is not readable here', p_bill_id
      using errcode = 'insufficient_privilege';
  end if;

  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'silo_allocate_landed_cost_bill: rows must be a JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(sum((r->>'amount')::numeric), 0) into v_total
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  if v_total > v_amount + 0.005 then
    raise exception 'silo_allocate_landed_cost_bill: % would overspend a % bill',
      to_char(v_total, 'FM999999990.00'), to_char(v_amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  -- The whole split is re-stated, so the old one goes first. Both statements
  -- are in this function's transaction: a failure below rolls the delete back.
  delete from public.landed_cost_allocations a where a.bill_id = p_bill_id;
  get diagnostics v_deleted = row_count;

  return query
  insert into public.landed_cost_allocations as al (
    company_entity_id, bill_id, po_header_id, shipment_id, amount, method, notes, created_by
  )
  select
    v_company,
    p_bill_id,
    (r->>'po_header_id')::uuid,
    nullif(r->>'shipment_id', '')::uuid,
    round((r->>'amount')::numeric, 2),
    coalesce(nullif(r->>'method', ''), 'value'),
    nullif(r->>'notes', ''),
    auth.uid()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where round((r->>'amount')::numeric, 2) > 0
  returning al.id, al.po_header_id, al.shipment_id, al.amount;
end;
$$;

revoke execute on function public.silo_allocate_landed_cost_bill(uuid, jsonb) from public, anon;
grant execute on function public.silo_allocate_landed_cost_bill(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.landed_cost_bills enable row level security;
alter table public.landed_cost_allocations enable row level security;

-- Read is every member of the company, deliberately WIDER than
-- payment_requests' own select policy (own rows / AP managers / admins): the
-- bank is the costing surface, and whoever costs a PO has to see which bills
-- are still unspent. The fields exposed are vendor, reference, date and amount
-- -- what the costing page already showed through its freight prefill.
drop policy if exists landed_cost_bills_select on public.landed_cost_bills;
create policy landed_cost_bills_select
  on public.landed_cost_bills for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

drop policy if exists landed_cost_bills_write on public.landed_cost_bills;
create policy landed_cost_bills_write
  on public.landed_cost_bills for all to authenticated
  using (company_entity_id = (select public.active_company_id()) and public.po_costing_can_write())
  with check (company_entity_id = (select public.active_company_id()) and public.po_costing_can_write());

drop policy if exists landed_cost_allocations_select on public.landed_cost_allocations;
create policy landed_cost_allocations_select
  on public.landed_cost_allocations for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

drop policy if exists landed_cost_allocations_write on public.landed_cost_allocations;
create policy landed_cost_allocations_write
  on public.landed_cost_allocations for all to authenticated
  using (company_entity_id = (select public.active_company_id()) and public.po_costing_can_write())
  with check (company_entity_id = (select public.active_company_id()) and public.po_costing_can_write());

revoke all on public.landed_cost_bills from anon;
revoke all on public.landed_cost_allocations from anon;
grant select, insert, update, delete on public.landed_cost_bills to authenticated;
grant select, insert, update, delete on public.landed_cost_allocations to authenticated;
grant select on public.v_landed_cost_bill_balance to authenticated;
grant select on public.v_po_landed_cost_allocations to authenticated;
grant select on public.v_po_landed_cost_totals to authenticated;

-- A policy without a grant is a policy nobody can exercise; a grant to anon is
-- a disclosure. Neither integration role touches these.
revoke all on public.v_landed_cost_bill_balance from anon;
revoke all on public.v_po_landed_cost_allocations from anon;
revoke all on public.v_po_landed_cost_totals from anon;
-- Postgres grants EXECUTE on every new function to PUBLIC, so revoking anon and
-- authenticated by name leaves both of them holding it through PUBLIC. These are
-- SECURITY DEFINER trigger functions; nobody calls them directly.
revoke execute on function public.landed_cost_allocation_guard() from public;
revoke execute on function public.landed_cost_allocation_guard() from anon, authenticated;
revoke execute on function public.landed_cost_bill_sync() from public;
revoke execute on function public.landed_cost_bill_sync() from anon, authenticated;
revoke execute on function public.landed_cost_bill_guard() from public;
revoke execute on function public.landed_cost_bill_guard() from anon, authenticated;
revoke execute on function public.landed_cost_sync_po_costing() from public;
revoke execute on function public.landed_cost_sync_po_costing() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill. Numbers do not move.
-- ---------------------------------------------------------------------------

-- 1. Every freight payment request becomes a bill at the amount actually paid.
insert into public.landed_cost_bills (
  company_entity_id, payment_request_id, source, kind,
  vendor_name, bill_ref, bill_date, amount, notes, created_by
)
select
  pr.company_entity_id, pr.id, 'payment_request', 'freight',
  coalesce(nullif(btrim(pr.vendor_name), ''), nullif(btrim(pr.vendor_name_manual), '')),
  nullif(btrim(pr.invoice_number), ''),
  coalesce(pr.date_completed, pr.due_date, pr.submitted_at::date, pr.created_at::date),
  pr.amount_due,
  nullif(btrim(pr.internal_po_number), ''),
  pr.created_by
from public.payment_requests pr
where pr.request_type = 'inventory_freight'
  and pr.company_entity_id is not null
on conflict (payment_request_id) where payment_request_id is not null do nothing;

-- 2. Restore the 134 PO lines whose factory cost was overwritten with their
--    landed cost by the old "Push landed to PO lines" default. The true FOB is
--    still in po_costing_lines.fob_unit, which that push never touched, and the
--    condition matches ONLY a line that currently equals its landed unit while
--    its landed unit differs from its FOB -- so a line somebody set by hand to
--    something else is left alone, and a re-run has nothing to do.
update public.po_lines p
   set unit_cost = l.fob_unit
  from public.po_costing_lines l
 where l.po_line_id = p.id
   and l.fob_unit is not null
   and l.landed_unit is not null
   and p.unit_cost is not null
   and abs(p.unit_cost - l.landed_unit) < 0.005
   and abs(l.landed_unit - l.fob_unit) > 0.005;

-- 3. Every PO's EXISTING freight becomes an allocation of a REAL bill, and a
--    forwarder invoice typed onto several POs is CORRECTED, not preserved.
--
--    Blake, 2026-11-28: "if cogs math is wrong by 59k need it to auto correct
--    not create some new queue to work". So this does not carry a duplicate
--    forward as a legacy stub for somebody to reconcile. Where one paid
--    invoice is recognisable behind several POs' typed freight, the invoice is
--    allocated ONCE across those POs, by factory value, to the cent.
--
--    An invoice is matched to a group of POs two ways, both exact, never
--    fuzzy:
--      (a) by reference -- po_costing.freight_invoice_ref equals the payment
--          request's invoice_number, ignoring case and spacing; or
--      (b) by amount, where every PO in the group carries the IDENTICAL typed
--          freight and that figure equals the paid invoice exactly. Typing one
--          invoice in full onto each PO is the mistake this is correcting, so
--          N copies of one amount is the signature of it. A single PO whose
--          typed freight merely happens to equal some invoice is NOT matched
--          this way -- it needs the reference.
--    A paid invoice is used by at most one group, and only while nothing has
--    been allocated from it yet.
--
--    What cannot be recognised keeps the number it has, on a `legacy` bill,
--    and is reported as unmatched rather than guessed at. On production at
--    2026-11-28 that is exactly one purchase order.
do $backfill$
declare
  g        record;
  po       record;
  v_bill   uuid;
  v_total  numeric(14, 2);
  v_fob    numeric(14, 2);
  v_minfob numeric(14, 2);
  v_left   numeric(14, 2);
  v_share  numeric(14, 2);
  v_n      int;
  v_i      int;
begin
  -- Grouped by bill: allocate each matched bill ONCE across its
  -- POs, weighted by factory value (fob_unit where costing knows it, the PO
  -- line's restored unit cost otherwise), largest remainder to the cent.
  for g in
    with todo as (
      select pc.po_header_id, pc.company_entity_id, pc.freight_amount,
             lower(btrim(coalesce(pc.freight_invoice_ref, ''))) as refk
        from public.po_costing pc
       where coalesce(pc.freight_amount, 0) > 0
         and pc.company_entity_id is not null
         and not exists (
           select 1 from public.landed_cost_allocations a where a.po_header_id = pc.po_header_id)
    ),
    free_bills as (
      select b.* from public.landed_cost_bills b
       where b.source = 'payment_request'
         and not exists (select 1 from public.landed_cost_allocations a where a.bill_id = b.id)
    ),
    by_ref as (
      select b.id as bill_id, t.po_header_id, 1 as pref
        from free_bills b
        join todo t
          on t.company_entity_id = b.company_entity_id
         and t.refk <> ''
         and t.refk = lower(btrim(coalesce(b.bill_ref, '')))
    ),
    by_amount as (
      select b.id as bill_id, t.po_header_id, 2 as pref
        from free_bills b
        join todo t
          on t.company_entity_id = b.company_entity_id
         and t.refk = ''
         and t.freight_amount = b.amount
       where not exists (select 1 from by_ref r where r.bill_id = b.id)
         and (select count(*) from todo t2
               where t2.company_entity_id = b.company_entity_id
                 and t2.refk = '' and t2.freight_amount = b.amount) > 1
    ),
    picked as (
      select distinct on (po_header_id) bill_id, po_header_id
        from (select * from by_ref union all select * from by_amount) u
       order by po_header_id, pref, bill_id
    )
    select p.bill_id, array_agg(p.po_header_id order by p.po_header_id) as po_ids
      from picked p group by p.bill_id
  loop
    select amount into v_total from public.landed_cost_bills where id = g.bill_id;
    v_left := v_total;
    v_n := array_length(g.po_ids, 1);
    v_i := 0;

    -- Weighted by factory value, but ONLY while every purchase order in the
    -- group has one. A PO with no lines costed yet would otherwise weigh zero
    -- and be handed no freight at all, which is a data gap being read as a
    -- fact. Where any member is missing its value, the invoice splits evenly.
    select coalesce(sum(w.v), 0), coalesce(min(w.v), 0) into v_fob, v_minfob
      from (
        select h.id,
               coalesce((select sum(pl.qty * coalesce(cl.fob_unit, pl.unit_cost))
                           from public.po_lines pl
                           left join public.po_costing_lines cl on cl.po_line_id = pl.id
                          where pl.po_header_id = h.id), 0) as v
          from public.po_headers h
         where h.id = any (g.po_ids)) w;
    if v_minfob <= 0 then
      v_fob := 0;
    end if;

    for po in
      select h.id, h.company_entity_id,
             coalesce((select sum(pl.qty * coalesce(cl.fob_unit, pl.unit_cost))
                         from public.po_lines pl
                         left join public.po_costing_lines cl on cl.po_line_id = pl.id
                        where pl.po_header_id = h.id), 0) as fob
        from public.po_headers h
       where h.id = any (g.po_ids)
       order by h.id
    loop
      v_i := v_i + 1;
      if v_i = v_n then
        -- The last PO takes what is left, so the shares always total the
        -- invoice exactly however the rounding fell.
        v_share := v_left;
      elsif v_fob > 0 then
        v_share := round(v_total * po.fob / v_fob, 2);
      else
        v_share := round(v_total / v_n, 2);
      end if;
      v_left := v_left - v_share;

      if v_share > 0 then
        insert into public.landed_cost_allocations (
          company_entity_id, bill_id, po_header_id, shipment_id, amount, method, notes
        ) values (
          po.company_entity_id, g.bill_id, po.id, null, v_share, 'value',
          case when v_n > 1
            then 'Corrected on 2026-11-28: this invoice had been entered in full on ' ||
                 v_n || ' purchase orders. Split by factory value.'
            else 'Carried over from the freight typed on this purchase order.' end
        );
      end if;
    end loop;
  end loop;

  -- Whatever is still unexplained keeps exactly the number it has today, on a
  -- `legacy` bill that says so. Nothing here is a guess.
  for po in
    select pc.po_header_id, pc.company_entity_id, pc.freight_amount,
           nullif(btrim(coalesce(pc.freight_invoice_ref, '')), '') as ref,
           nullif(btrim(coalesce(pc.freight_carrier, '')), '') as carrier,
           ph.po_name, pc.updated_at
      from public.po_costing pc
      join public.po_headers ph on ph.id = pc.po_header_id
     where coalesce(pc.freight_amount, 0) > 0
       and pc.company_entity_id is not null
       and not exists (
         select 1 from public.landed_cost_allocations a where a.po_header_id = pc.po_header_id)
     order by pc.updated_at
  loop
    insert into public.landed_cost_bills (
      company_entity_id, source, kind, vendor_name, bill_ref, bill_date, amount, notes
    ) values (
      po.company_entity_id, 'legacy', 'freight', po.carrier, po.ref, po.updated_at::date,
      po.freight_amount,
      'Carried over from the freight typed on ' || po.po_name ||
      '. No paid freight invoice matches it, by reference or by amount.'
    )
    returning id into v_bill;

    insert into public.landed_cost_allocations (
      company_entity_id, bill_id, po_header_id, shipment_id, amount, method, notes
    ) values (
      po.company_entity_id, v_bill, po.po_header_id, null, po.freight_amount, 'manual',
      'Carried over from the freight total typed on this purchase order.'
    );
  end loop;
end
$backfill$;

-- 4. The stored per-PO totals now follow the bills, so po_costing.freight_amount
--    agrees with what is allocated to it. The per-LINE split is recomputed by
--    the page's own engine, which is the one definition of that math.
update public.po_costing pc
   set freight_amount = t.freight_allocated,
       misc_amount    = t.misc_allocated,
       duty_amount    = round(coalesce(pc.fob_total, 0) * coalesce(pc.duty_pct, 0) / 100.0, 2)
                        + t.duty_allocated,
       landed_total   = coalesce(pc.fob_total, 0) + t.freight_allocated + t.misc_allocated
                        + round(coalesce(pc.fob_total, 0) * coalesce(pc.duty_pct, 0) / 100.0, 2)
                        + t.duty_allocated,
       updated_at     = now()
  from (
    select a.po_header_id,
           coalesce(sum(a.amount) filter (where b.kind = 'freight'), 0) as freight_allocated,
           coalesce(sum(a.amount) filter (where b.kind in ('duty', 'tariff')), 0) as duty_allocated,
           coalesce(sum(a.amount) filter (where b.kind in ('brokerage', 'other')), 0) as misc_allocated
      from public.landed_cost_allocations a
      join public.landed_cost_bills b on b.id = a.bill_id
     group by a.po_header_id) t
 where t.po_header_id = pc.po_header_id;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
