-- Balance sheet supporting schedules: the amortisation family.
--
-- WHY THIS EXISTS. Baseballism's Prepaid account (QBO 290) went from $94,270.68
-- to $518,474.52 between January and July 2026 across eight transactions, and
-- NOT ONE of them was ever amortised -- every entry adds, nothing is recognised.
-- Licensing guarantees to MLB, Universal and IMG are sitting on the balance
-- sheet in full while the periods they cover elapse. Expense is understated and
-- the asset overstated by whatever the correct recognition would have been.
--
-- WHAT GENERALISES, AND WHAT DOES NOT. Prepaids, deferred revenue, deferred
-- costs and prepaid insurance are one mechanic: an amount, a service period,
-- recognised over time against a GL account, with a declining balance that must
-- tie to that account. Identical fields, identical arithmetic, opposite signs
-- for asset versus liability -- hence one table with a schedule_type.
--
-- LEASES ARE DELIBERATELY NOT MODELLED HERE. What the finance team asked for on
-- leases is a REGISTER, not an amortisation: location, address, term, base rent,
-- triple nets, escalation anniversary, when it comes due, whether there is a
-- renewal obligation. Different fields serving a different question ("what are
-- we committed to") from this one ("what have we not yet recognised"). Forcing
-- them together would give both a worse home.
--
-- THE ITEM AND THE STAMP ARE DIFFERENT THINGS. An item is the agreement. A stamp
-- links one QuickBooks transaction to it. That relationship is one-to-many on
-- purpose: the March, June and July payments to MLB may be installments against
-- a single guarantee, in which case they stamp to one item with one service
-- period -- or three separate deals, in which case three items. The model does
-- not force that decision at schema time.
--
-- Nothing here posts to QuickBooks. Generated periods are a proposal a human
-- reads; quickbooks_journal_postings exists for when that changes.

create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- The amortisation family. Leases are absent by design (see above).
  schedule_type text not null default 'prepaid'
    check (schedule_type in ('prepaid', 'deferred_revenue', 'deferred_cost', 'other')),

  -- Human label. The QuickBooks memo cannot serve as identity: real ones read
  -- "007000720123322 OUTGOING MONEY TRANSFER BOB DOMESTIC ACCT#******2588
  -- UNIVERSAL STUDIOS LICENSING LLC..." -- a bank wire string, not a description.
  label text not null,
  description text,
  vendor_name text,

  -- The balance sheet account this item lives in, so the schedule can be tied
  -- back to it. Bound by QBO account id, never by name.
  qbo_account_id text not null,
  qbo_account_name text,

  -- The account the recognition hits. Optional until someone decides it; a
  -- schedule is useful for the tie-out before the expense side is settled.
  qbo_expense_account_id text,
  qbo_expense_account_name text,

  -- The service period. THIS IS THE FIELD QUICKBOOKS DOES NOT HAVE -- nothing in
  -- the ledger records what span a payment covers, which is exactly why a human
  -- has to stamp it.
  service_start date not null,
  service_end date not null,
  constraint schedule_items_period_ordered check (service_end >= service_start),

  -- straight_line is monthly on a calendar basis. Others exist so the column
  -- does not have to be widened later, but only straight_line is implemented.
  method text not null default 'straight_line'
    check (method in ('straight_line', 'manual')),

  status text not null default 'active'
    check (status in ('active', 'fully_recognized', 'closed')),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_schedule_items_company_account
  on public.schedule_items (company_entity_id, qbo_account_id, status);

-- The stamps: which QuickBooks transactions make up this item.
create table if not exists public.schedule_item_transactions (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,

  -- QBO's transaction id from the General Ledger report. The identity anchor:
  -- it survives a memo being rewritten, which a description would not.
  qbo_txn_id text not null,
  qbo_txn_type text,
  txn_date date not null,
  amount numeric(14,2) not null,

  -- Kept for display so the schedule can show what was stamped without
  -- re-fetching the report.
  memo text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- One transaction belongs to at most one schedule item. Stamping the same
-- payment twice would double-count the balance and silently break the tie-out
-- against the QuickBooks account -- the exact failure a reconciliation exists
-- to catch.
create unique index if not exists uq_schedule_item_txn_once
  on public.schedule_item_transactions (company_entity_id, qbo_txn_id);

create index if not exists idx_schedule_item_txns_item
  on public.schedule_item_transactions (schedule_item_id);

alter table public.schedule_items enable row level security;
alter table public.schedule_item_transactions enable row level security;

-- Same gate as the rest of the accounting surface: company-scoped, and any
-- active member may read and maintain it. Nothing here reaches QuickBooks, so
-- an admin gate would only stop finance from doing their own work.
drop policy if exists schedule_items_active_all on public.schedule_items;
create policy schedule_items_active_all
  on public.schedule_items for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop policy if exists schedule_item_txns_active_all on public.schedule_item_transactions;
create policy schedule_item_txns_active_all
  on public.schedule_item_transactions for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.schedule_items;
create trigger stamp_created_by
  before insert on public.schedule_items
  for each row execute function public.stamp_created_by();

drop trigger if exists stamp_created_by on public.schedule_item_transactions;
create trigger stamp_created_by
  before insert on public.schedule_item_transactions
  for each row execute function public.stamp_created_by();

-- Amortisation is COMPUTED, never stored. Storing generated periods means an
-- edited service period leaves stale rows behind, and the schedule silently
-- stops agreeing with its own item. A view cannot drift from its inputs.
create or replace view public.schedule_item_amortization_v
with (security_invoker = true) as
with totals as (
  select i.id as schedule_item_id,
         i.company_entity_id,
         i.schedule_type,
         i.label,
         i.qbo_account_id,
         i.qbo_account_name,
         i.qbo_expense_account_id,
         i.service_start,
         i.service_end,
         i.status,
         coalesce(sum(t.amount), 0)::numeric(14,2) as total_amount,
         -- Whole calendar months inclusive of both ends: a 15 Mar - 14 Feb term
         -- is twelve periods, not eleven.
         (date_part('year',  age(date_trunc('month', i.service_end),
                                 date_trunc('month', i.service_start))) * 12
        + date_part('month', age(date_trunc('month', i.service_end),
                                 date_trunc('month', i.service_start))))::int + 1 as months
  from public.schedule_items i
  left join public.schedule_item_transactions t on t.schedule_item_id = i.id
  group by i.id
),
periods as (
  select t.*,
         gs.period_start::date as period_start,
         (gs.period_start + interval '1 month - 1 day')::date as period_end,
         row_number() over (partition by t.schedule_item_id order by gs.period_start) as period_no
  from totals t
  cross join lateral generate_series(
    date_trunc('month', t.service_start),
    date_trunc('month', t.service_end),
    interval '1 month'
  ) gs(period_start)
)
select p.schedule_item_id,
       p.company_entity_id,
       p.schedule_type,
       p.label,
       p.qbo_account_id,
       p.qbo_account_name,
       p.qbo_expense_account_id,
       p.status,
       p.period_start,
       p.period_end,
       p.period_no,
       p.months,
       p.total_amount,
       -- The final period absorbs the rounding remainder so the periods sum to
       -- the stamped total exactly. Without this a 12-way split of an odd cent
       -- leaves the schedule permanently a penny off the ledger, which is
       -- indistinguishable from a real break.
       case
         when p.months <= 0 then 0::numeric(14,2)
         when p.period_no < p.months then round(p.total_amount / p.months, 2)
         else p.total_amount - (round(p.total_amount / p.months, 2) * (p.months - 1))
       end as period_amount
from periods p;

comment on view public.schedule_item_amortization_v is
  'One row per schedule item per calendar month of its service period, with the amount to recognise. Computed from schedule_items and their stamped transactions -- never stored, so an edited term cannot leave stale periods behind. The final period absorbs rounding so periods sum to the stamped total exactly.';

-- Per-item position as at a date. `recognized_to_date` counts periods whose
-- month has ENDED, which is the month-close convention: July is recognised when
-- July is closed, not on 1 July.
create or replace view public.schedule_item_balances_v
with (security_invoker = true) as
select a.schedule_item_id,
       a.company_entity_id,
       a.schedule_type,
       a.label,
       a.qbo_account_id,
       a.qbo_account_name,
       a.status,
       min(a.period_start) as service_start,
       max(a.period_end)   as service_end,
       max(a.months)       as months,
       max(a.total_amount) as total_amount,
       coalesce(sum(a.period_amount) filter (where a.period_end <= current_date), 0)::numeric(14,2)
         as recognized_to_date,
       (max(a.total_amount)
         - coalesce(sum(a.period_amount) filter (where a.period_end <= current_date), 0))::numeric(14,2)
         as remaining_balance,
       count(*) filter (where a.period_end <= current_date) as periods_elapsed
from public.schedule_item_amortization_v a
group by a.schedule_item_id, a.company_entity_id, a.schedule_type, a.label,
         a.qbo_account_id, a.qbo_account_name, a.status;

comment on view public.schedule_item_balances_v is
  'Per schedule item: total stamped, recognised to date, and remaining balance. Recognition counts periods whose month has ENDED, matching month-close convention. Summing remaining_balance across items for one qbo_account_id is the figure that must tie to that account on the QuickBooks balance sheet.';

grant select on public.schedule_item_amortization_v to authenticated;
grant select on public.schedule_item_balances_v to authenticated;
