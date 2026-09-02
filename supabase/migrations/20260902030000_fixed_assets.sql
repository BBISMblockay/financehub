-- Fixed asset depreciation subledger.
--
-- WHY THIS EXISTS. QBO owns the general ledger (docs/ops/quickbooks-integration.md,
-- 2026-08-26): SILO does not replicate double-entry, reconciliation, or a fixed
-- asset ledger. That boundary is about not duplicating QBO's own books, not
-- about refusing to compute a supporting schedule and hand a human a journal
-- entry to review -- schedule_items (20260827220000) already established that
-- shape for prepaids, and this is the same posture for depreciation: SILO
-- computes the schedule, a human decides whether and when to post it, QBO
-- stays the system of record for the asset and the entry both.
--
-- WHY A SEPARATE TABLE FROM schedule_items, NOT A NEW schedule_type. Prepaid
-- items reduce a SINGLE balance sheet account (the prepaid asset) straight to
-- zero over a service period, and schedule_items' fields (service_start,
-- service_end, qbo_account_id, qbo_expense_account_id) say exactly that. A
-- fixed asset is a different shape: it has an original COST that never
-- changes, a SALVAGE VALUE the depreciable base excludes, and -- the part
-- that does not fit schedule_items at all -- depreciation is posted to a
-- THIRD account, accumulated depreciation, never to the asset account itself.
-- Net book value is cost minus accumulated depreciation, both held on the
-- books; the asset account keeps the original cost forever until disposal.
-- Forcing that into schedule_items' two-account shape would either be wrong
-- (crediting the asset account, which is not how depreciation works) or
-- require widening a table three other things already read, for a mechanic
-- that is genuinely different. Same reasoning schedule_items itself used to
-- keep leases out: different fields serving a different question deserve a
-- different home.
--
-- ONLY STRAIGHT-LINE IS IMPLEMENTED, matching schedule_items' own precedent.
-- The method column exists so it does not have to be widened later; nothing
-- computes declining balance today.
--
-- DISPOSAL is a first-class field, unlike schedule_items (which has no
-- equivalent): a fixed asset register that cannot say "we sold this truck"
-- is unusable within a year of real use. Setting disposal_date stops the
-- schedule generating periods past that month. It does NOT compute a
-- disposal gain or loss -- proceeds vs. net book value is a distinct
-- question nobody has asked for yet, and answering it silently wrong would
-- misstate a P&L line no one asked SILO to touch.

create table if not exists public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  label text not null,
  description text,
  vendor_name text,

  -- The balance sheet account holding this asset's original cost. Depreciation
  -- never credits this account -- see qbo_accum_depreciation_account_id.
  qbo_asset_account_id text not null,
  qbo_asset_account_name text,

  -- The expense side of the monthly entry. Optional until someone decides it,
  -- same as schedule_items.qbo_expense_account_id -- the register is useful
  -- for tracking net book value before the posting side is settled.
  qbo_depreciation_expense_account_id text,
  qbo_depreciation_expense_account_name text,

  -- The contra-asset side depreciation actually credits. Required for the
  -- same reason as the expense account -- both are checked before a period
  -- can be posted, not just one.
  qbo_accum_depreciation_account_id text,
  qbo_accum_depreciation_account_name text,

  in_service_date date not null,
  cost numeric(14,2) not null check (cost > 0),
  salvage_value numeric(14,2) not null default 0 check (salvage_value >= 0 and salvage_value < cost),
  useful_life_months integer not null check (useful_life_months > 0),

  method text not null default 'straight_line'
    check (method in ('straight_line', 'manual')),

  disposal_date date,
  constraint fixed_assets_disposal_after_service
    check (disposal_date is null or disposal_date >= in_service_date),

  status text not null default 'active'
    check (status in ('active', 'disposed', 'closed')),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_fixed_assets_company_account
  on public.fixed_assets (company_entity_id, qbo_asset_account_id, status);

alter table public.fixed_assets enable row level security;

-- Same gate as schedule_items: company-scoped, any active member may read and
-- maintain the register. Nothing here reaches QuickBooks, so an admin gate
-- would only stop finance from doing their own work.
drop policy if exists fixed_assets_active_all on public.fixed_assets;
create policy fixed_assets_active_all
  on public.fixed_assets for all
  to authenticated
  using (company_entity_id = public.active_company_id())
  with check (company_entity_id = public.active_company_id());

drop trigger if exists stamp_created_by on public.fixed_assets;
create trigger stamp_created_by
  before insert on public.fixed_assets
  for each row execute function public.stamp_created_by();

-- Depreciation is COMPUTED, never stored -- same reasoning as
-- schedule_item_amortization_v: storing generated periods means an edited
-- useful life or a corrected cost leaves stale rows behind, silently
-- disagreeing with the asset it was computed from.
create or replace view public.fixed_asset_depreciation_v
with (security_invoker = true) as
with base as (
  select a.id as fixed_asset_id,
         a.company_entity_id,
         a.label,
         a.qbo_asset_account_id,
         a.qbo_asset_account_name,
         a.qbo_depreciation_expense_account_id,
         a.qbo_accum_depreciation_account_id,
         a.status,
         a.in_service_date,
         a.disposal_date,
         a.cost,
         (a.cost - a.salvage_value)::numeric(14,2) as depreciable_base,
         -- The divisor for every period's amount. NEVER shortened by
         -- disposal -- disposing an asset early does not mean it depreciates
         -- faster, it means fewer periods get generated (below) at the same
         -- monthly rate. Conflating the two force-fully-depreciates an asset
         -- the moment it is disposed, which is wrong: net book value at
         -- disposal is exactly the information a later gain/loss calculation
         -- needs, and this would always report it as zero. (Caught by a
         -- prod sanity check before this ever reached the UI: a 24-month
         -- asset disposed after 6 months was recognising the full cost in
         -- those 6 months instead of 6/24 of it.)
         a.useful_life_months as nominal_months,
         -- How many periods to actually generate. Shortened by disposal to
         -- however many full months the asset was actually in service.
         least(
           a.useful_life_months,
           case when a.disposal_date is null then a.useful_life_months
             else greatest(1,
               (date_part('year',  age(date_trunc('month', a.disposal_date),
                                       date_trunc('month', a.in_service_date))) * 12
              + date_part('month', age(date_trunc('month', a.disposal_date),
                                       date_trunc('month', a.in_service_date))))::int + 1)
           end
         ) as periods_to_generate
  from public.fixed_assets a
),
periods as (
  select b.*,
         gs.period_start::date as period_start,
         (gs.period_start + interval '1 month - 1 day')::date as period_end,
         row_number() over (partition by b.fixed_asset_id order by gs.period_start) as period_no
  from base b
  cross join lateral generate_series(
    date_trunc('month', b.in_service_date),
    date_trunc('month', b.in_service_date) + ((b.periods_to_generate - 1) || ' months')::interval,
    interval '1 month'
  ) gs(period_start)
)
select p.fixed_asset_id,
       p.company_entity_id,
       p.label,
       p.qbo_asset_account_id,
       p.qbo_asset_account_name,
       p.qbo_depreciation_expense_account_id,
       p.qbo_accum_depreciation_account_id,
       p.status,
       p.cost,
       p.period_start,
       p.period_end,
       p.period_no,
       p.nominal_months as months,
       p.depreciable_base,
       -- The regular monthly amount, against the FULL nominal life. Only the
       -- asset's TRUE final period (period_no = nominal_months) absorbs the
       -- rounding remainder -- reachable only when nothing disposed it
       -- early, since periods_to_generate caps at nominal_months. A period
       -- reached only because of an early disposal is never period
       -- nominal_months (periods_to_generate < nominal_months in that case),
       -- so it always gets the plain monthly amount, leaving the true
       -- remainder as net book value rather than force-recognising it.
       case
         when p.nominal_months <= 0 then 0::numeric(14,2)
         when p.period_no < p.nominal_months then round(p.depreciable_base / p.nominal_months, 2)
         else p.depreciable_base - (round(p.depreciable_base / p.nominal_months, 2) * (p.nominal_months - 1))
       end as period_amount
from periods p;

comment on view public.fixed_asset_depreciation_v is
  'One row per fixed asset per calendar month of its depreciable life, with the amount to recognise. Computed from fixed_assets -- never stored. Each period is depreciable_base / useful_life_months (the divisor is NEVER shortened by disposal); only the true final period at full nominal life absorbs the rounding remainder. disposal_date shortens how many periods are GENERATED, not the per-period amount -- an asset disposed early simply stops accruing, leaving the true remainder as net book value rather than force-recognising it.';

-- Per-asset position as at today. accumulated_depreciation counts periods
-- whose month has ENDED (month-close convention, same as schedule_items).
create or replace view public.fixed_asset_balances_v
with (security_invoker = true) as
select d.fixed_asset_id,
       d.company_entity_id,
       d.label,
       d.qbo_asset_account_id,
       d.qbo_asset_account_name,
       d.status,
       min(d.period_start) as depreciation_start,
       max(d.period_end)   as depreciation_end,
       max(d.months)       as months,
       max(d.cost)         as cost,
       max(d.depreciable_base) as depreciable_base,
       coalesce(sum(d.period_amount) filter (where d.period_end <= current_date), 0)::numeric(14,2)
         as accumulated_depreciation,
       (max(d.cost)
         - coalesce(sum(d.period_amount) filter (where d.period_end <= current_date), 0))::numeric(14,2)
         as net_book_value,
       count(*) filter (where d.period_end <= current_date) as periods_elapsed
from public.fixed_asset_depreciation_v d
group by d.fixed_asset_id, d.company_entity_id, d.label, d.qbo_asset_account_id,
         d.qbo_asset_account_name, d.status;

comment on view public.fixed_asset_balances_v is
  'Per fixed asset: cost, accumulated depreciation to date, and net book value (cost minus accumulated depreciation -- never below salvage value once fully depreciated). Recognition counts periods whose month has ENDED, matching month-close convention.';

grant select on public.fixed_asset_depreciation_v to authenticated;
grant select on public.fixed_asset_balances_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  is_hidden = false,
  keywords = array['fixed asset','depreciation','asset register','net book value',
                   'accumulated depreciation','straight line','useful life','disposal'],
  description = $d$Fixed asset register: label, cost, salvage value, useful life (months), in-service date, and the three QuickBooks accounts a depreciation entry touches (the asset account itself, the depreciation expense account, and accumulated depreciation -- a separate contra-asset account depreciation credits, never the asset account). Only straight-line is implemented. disposal_date, when set, shortens the schedule to the months actually in service. Depreciation is computed, never stored -- see fixed_asset_depreciation_v (one row per asset per month) and fixed_asset_balances_v (net book value as at today).$d$
where relname = 'fixed_assets';
