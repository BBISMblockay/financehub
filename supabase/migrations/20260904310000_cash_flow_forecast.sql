-- Cash flow forecast: a 13-week liquidity planner, and the liquidity stack
-- (cash + available credit) that sits above it.
--
-- WHAT THIS ANSWERS. Not "what did QBO's CashFlow report say" (the indirect-
-- method P&L-driven statement -- see quickbooks-report's CashFlow support,
-- 2026-09-02) but the finance-team question underneath a real 13-week cash
-- planner spreadsheet: how much cash and available credit do we actually
-- have, and where does the balance go over the next 13 weeks given what we
-- already owe (Request Manager), what we plan to make (revenue_projections),
-- what we've been making (sales_by_day trend), and what nothing else in
-- SILO knows about yet (this migration's two tables).
--
-- credit_facilities: QBO tracks a credit card or line of credit's CURRENT
-- BALANCE (a liability account), never its LIMIT -- that fact lives nowhere
-- but a person's head or a spreadsheet. This table pairs a manually-entered
-- limit with an optional link to the QBO liability account carrying the
-- balance owed, so "available credit" = limit - balance owed can be computed
-- without ever asking QBO for something it does not have.
--
-- cash_forecast_items: one register for two things that are the same shape
-- (an amount, a date or a cadence, no other system captures it) but
-- different intent -- a RECURRING fixed cost (Rent, Payroll, META ad spend)
-- and a ONE-TIME planning input (an expected loan draw, a known one-off
-- payment). Splitting them into two tables would duplicate every column;
-- `kind` distinguishes them and `cadence` is simply null for one-time rows.
-- Signed amount (positive = inflow, negative = outflow) rather than a
-- separate direction column, matching the sign convention already used by
-- comp requests and payment amounts elsewhere in this schema.

create table if not exists public.credit_facilities (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  label text not null,
  facility_type text not null default 'credit_card'
    check (facility_type in ('credit_card', 'line_of_credit', 'term_loan', 'other')),

  -- The QBO liability account carrying the current balance owed. Nullable --
  -- a facility can be tracked here before anyone wires it to the chart, same
  -- "optional until someone decides it" posture as schedule_items and
  -- fixed_assets' recognition-side accounts. Unlinked facilities show their
  -- full limit as available (never drawn against, so far as SILO can tell)
  -- and the UI says so rather than silently treating null as zero drawn.
  qbo_account_id text,
  qbo_account_name text,

  credit_limit numeric(14,2) not null check (credit_limit > 0),

  is_active boolean not null default true,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_credit_facilities_company
  on public.credit_facilities (company_entity_id, is_active);

alter table public.credit_facilities enable row level security;

drop policy if exists credit_facilities_active_all on public.credit_facilities;
create policy credit_facilities_active_all
  on public.credit_facilities for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.credit_facilities;
create trigger stamp_created_by
  before insert on public.credit_facilities
  for each row execute function public.stamp_created_by();

create table if not exists public.cash_forecast_items (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  label text not null,
  -- Free text, not an enum -- matches a real cash-flow spreadsheet's own
  -- category rows (Rent, Payroll + Tax, META, Utilities, Insurance...)
  -- rather than forcing them into a fixed list before this ships.
  category text,

  -- Positive = inflow, negative = outflow.
  amount numeric(14,2) not null check (amount <> 0),

  kind text not null check (kind in ('recurring', 'one_time')),
  cadence text
    check (cadence in ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual')),
  constraint cash_forecast_items_cadence_matches_kind check (
    (kind = 'recurring' and cadence is not null)
    or (kind = 'one_time' and cadence is null)
  ),

  -- One-time: the expected date itself. Recurring: the anchor date its
  -- occurrences are generated forward from.
  start_date date not null,
  -- Recurring only: an optional cutoff (a lease ending, a loan paying off).
  -- Meaningless for one_time, which already has exactly one occurrence.
  end_date date,
  constraint cash_forecast_items_end_after_start
    check (end_date is null or end_date >= start_date),

  is_active boolean not null default true,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_cash_forecast_items_company
  on public.cash_forecast_items (company_entity_id, is_active);

alter table public.cash_forecast_items enable row level security;

drop policy if exists cash_forecast_items_active_all on public.cash_forecast_items;
create policy cash_forecast_items_active_all
  on public.cash_forecast_items for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.cash_forecast_items;
create trigger stamp_created_by
  before insert on public.cash_forecast_items
  for each row execute function public.stamp_created_by();

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['cash flow forecast','13 week cash flow','liquidity','credit facility',
                   'available credit','line of credit','recurring cost','cash planner'],
  description = $d$Credit facilities (cards and lines of credit) with a manually-entered limit paired to the QBO liability account carrying the current balance owed -- QBO tracks the balance, never the limit. available_credit = credit_limit - current balance owed, computed at read time from a live QuickBooks fetch, not stored here. Feeds the liquidity stack on the cash flow forecast page alongside QBO bank account balances.$d$
where relname = 'credit_facilities';

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['cash flow forecast','recurring cost','one time payment','planning input',
                   'rent','payroll','ad spend','loan draw','13 week cash flow'],
  description = $d$Manual cash flow planning lines the forecast can't derive from Request Manager or revenue projections: recurring fixed costs (kind='recurring', a cadence, generated forward from start_date) like Rent/Payroll/META ad spend that are often paid outside Request Manager, and one-time planning inputs (kind='one_time', a single start_date) like an expected loan draw or a known one-off payment. amount is signed: positive = inflow, negative = outflow.$d$
where relname = 'cash_forecast_items';
