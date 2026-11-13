-- Journal → source drill-down, so a connected AI can RECONCILE rather than
-- only read the ledger.
--
-- WHY (Blake, 2026-11-13): "accounting recon within MCP ... its currently only
-- pulling journal entries, but silo has the breakdown because it posted the
-- journal, that gap needs closed."
--
-- WHAT WAS MISSING, measured on production 2026-11-13:
--
--   1. HALF THE JOURNAL LINES WERE INVISIBLE. journal_adjustment_lines is a
--      table and is in Ask SILO's catalog, so a bot can read the lines of a
--      hand-written adjustment. A CARD/BANK BATCH's lines are not rows
--      anywhere -- they live inside card_import_batches.approval_snapshot ->
--      'payload' -> 'Line', the frozen array that quickbooks-post-journal
--      sends to Intuit. 33 of the 41 postings this company has made are
--      card_import. A bot asking "show me the journal entries" therefore saw
--      the adjustments and nothing of the batches.
--
--   2. NO LINE REACHED ITS SOURCE. Even with the lines, nothing joins a
--      posted figure to the records behind it: the bank rows in a batch, the
--      per-day per-location sales behind a monthly Shopify summary, the
--      payouts whose fees it books, the schedule items behind an
--      amortization, the assets behind depreciation, the transaction behind
--      a reclass. SILO holds every one of those -- it is what SILO built the
--      entry FROM -- but the link was convention (accounting_source plus a
--      YYYY-MM in accounting_source_ref / source_context), readable by the
--      pages and by nothing else.
--
-- WHAT THIS ADDS -- two security_invoker views and one system report. No new
-- table, no RPC, no scope, no grant beyond the two views, no change to any
-- posting path. Nothing here defines a posted line: the lines view READS the
-- frozen approval snapshot, it does not recompute one (see
-- card_coding_effective_lines' note in supabase/CLAUDE.md).
--
--   accounting_journal_lines_v
--     One row per journal line of every entry, both kinds, in one shape.
--     Adjustments come from their stored lines; batches are the frozen
--     approval snapshot expanded, with account and location names resolved
--     against the batch's own QuickBooks connection. A batch posted before
--     snapshots existed falls back to the posting's own payload -- the same
--     array, from the other end of the same send -- because four of this
--     company's fourteen posted batches have no snapshot and a posted entry
--     a reconciler cannot see is the worst outcome available. lines_basis
--     says which was used.
--     A batch with neither (draft / categorized -- not yet a journal)
--     contributes no rows: "Accounting close status" is where unfinished
--     coding is counted, and emitting half an entry would let a bot conclude
--     the books are out of balance when they are merely unapproved.
--
--   accounting_journal_sources_v
--     One row per SOURCE RECORD behind an entry, with the entry's identity on
--     every row so it joins straight back to the lines view.
--       card_batch              -> one row per coded line of each transaction
--                                  in the batch (card_coding_effective_lines,
--                                  so a split shows its lines, not one
--                                  blended row), basis as_posted.
--       shopify_monthly         -> one row per location per day from
--                                  sales_by_day_verification_v, the same
--                                  relation accounting_sales_buckets() reads,
--                                  plus one row per shopify_payouts row in
--                                  the period carrying the fee the entry
--                                  books. basis recomputed.
--       prepaid_amortization    -> schedule_item_amortization_v rows whose
--                                  period is the entry's. basis recomputed.
--       fixed_asset_depreciation-> fixed_asset_depreciation_v, same.
--       card_reclass            -> the card_transactions row being reclassed,
--                                  from/to account on it. basis as_posted.
--       anything else           -> no rows. A hand-written manual_adjustment
--                                  HAS no source, and saying so by absence is
--                                  the honest answer; source_basis is never
--                                  guessed.
--
--     source_basis is the whole safety property of this view. 'as_posted'
--     means the rows are frozen with the entry and will still tie next year.
--     'recomputed' means they are read from today's data over the entry's
--     period -- which is exactly what makes reconciliation useful (a drift
--     between the entry and the source IS the finding) and exactly why it
--     must never be presented as what was posted. The entry's own figures are
--     in accounting_journal_lines_v; this view is the other side of that
--     comparison, never a substitute for it.
--
--     period_start / period_end are on every row, so the window a recomputed
--     source was read over is visible rather than assumed. It is taken from
--     the batch's own period_start/period_end for a card batch, and for an
--     adjustment from the first YYYY-MM in accounting_source_ref, else in
--     source_context, else the entry_date's own month. (quickbooks_journal_
--     postings.period_start/period_end are NOT used: for every monthly
--     posting on production both equal the entry date, so they carry the
--     posting day, not the period.)
--
-- GENERIC BY CONSTRUCTION. No company, entity_key or entity id appears
-- anywhere here; every branch keys on accounting_source, which is SILO's own
-- vocabulary for what produced an entry, and a company with no Shopify, no
-- schedules or no fixed assets simply has no rows of those kinds.
--
-- RLS IS STILL THE BOUNDARY. Both views are security_invoker = true, so they
-- read exactly what the caller reads: journal_adjustments and
-- card_import_batches are gated by can_manage_journal_entries(), and a person
-- who cannot see an entry sees none of its sources either. Through the MCP
-- the caller is the person who granted the connection, under that grant's
-- company. The views add no filter that could widen this and select no column
-- that its base table does not already expose to that caller.
--
-- Idempotent: create or replace throughout; the report uses a fixed id with
-- on conflict do update, and its tie-outs are deleted and rewritten.

begin;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Every journal line, both kinds, one shape
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.accounting_journal_lines_v
with (security_invoker = true) as
  -- Hand-written and generated adjustments: the lines are rows already.
  select
    a.company_entity_id,
    a.id                                   as journal_id,
    'journal_adjustment'::text             as kind,
    a.entry_date,
    a.memo,
    -- Same two unambiguous context prefixes the sources view recovers, so a
    -- 2026-08 entry written before accounting_source existed reads the same
    -- in both views. See the note there.
    coalesce(
      a.accounting_source,
      case
        when a.source_context like 'fixed-assets:depreciation%' then 'fixed_asset_depreciation'
        when a.source_context like 'schedules:prepaid%'         then 'prepaid_amortization'
      end
    )                                      as accounting_source,
    a.source_context,
    a.accounting_source_ref,
    a.status,
    a.posting_id,
    p.status                               as posting_status,
    p.qbo_journal_entry_id,
    p.qbo_doc_number,
    l.line_no,
    l.qbo_account_id,
    l.qbo_account_name,
    l.posting_type,
    l.amount,
    case when l.posting_type = 'Credit' then -l.amount else l.amount end as signed_amount,
    l.qbo_location_id,
    l.qbo_location_name,
    l.entity_type,
    l.entity_qbo_id,
    l.entity_name,
    l.description,
    'stored'::text                         as lines_basis
  from public.journal_adjustments a
  join public.journal_adjustment_lines l
    on l.adjustment_id = a.id
   and l.company_entity_id = a.company_entity_id
  left join public.quickbooks_journal_postings p
    on p.id = a.posting_id

  union all

  -- Card / bank batches: the lines are the frozen approval snapshot. Expanded
  -- here, never recomputed -- what a reconciler must see is what was sent.
  select
    b.company_entity_id,
    b.id                                   as journal_id,
    'card_batch'::text                     as kind,
    b.entry_date,
    s.display_name                         as memo,
    'transactions'::text                   as accounting_source,
    null::text                             as source_context,
    null::text                             as accounting_source_ref,
    b.status,
    b.posting_id,
    p.status                               as posting_status,
    p.qbo_journal_entry_id,
    p.qbo_doc_number,
    e.n::integer                           as line_no,
    e.elem -> 'JournalEntryLineDetail' -> 'AccountRef' ->> 'value'     as qbo_account_id,
    acc.name                                                           as qbo_account_name,
    e.elem -> 'JournalEntryLineDetail' ->> 'PostingType'               as posting_type,
    round((e.elem ->> 'Amount')::numeric, 2)                           as amount,
    case when e.elem -> 'JournalEntryLineDetail' ->> 'PostingType' = 'Credit'
         then -round((e.elem ->> 'Amount')::numeric, 2)
         else  round((e.elem ->> 'Amount')::numeric, 2) end            as signed_amount,
    e.elem -> 'JournalEntryLineDetail' -> 'DepartmentRef' ->> 'value'  as qbo_location_id,
    loc.name                                                           as qbo_location_name,
    e.elem -> 'JournalEntryLineDetail' -> 'Entity' ->> 'Type'          as entity_type,
    e.elem -> 'JournalEntryLineDetail' -> 'Entity' -> 'EntityRef' ->> 'value' as entity_qbo_id,
    null::text                             as entity_name,
    e.elem ->> 'Description'               as description,
    case when b.approval_snapshot -> 'payload' -> 'Line' is not null
         then 'approval_snapshot' else 'posting_payload' end as lines_basis
  from public.card_import_batches b
  join public.card_sources s
    on s.id = b.source_id
  left join public.quickbooks_journal_postings p
    on p.id = b.posting_id
  -- The frozen approval snapshot, and for a batch posted before snapshots
  -- existed the posting's own payload -- the exact array sent to Intuit
  -- either way. Four of this company's fourteen posted batches (all
  -- 2026-08-31) predate the snapshot and would otherwise be invisible here
  -- while being posted in QuickBooks, which is the worst of both.
  cross join lateral jsonb_array_elements(
         coalesce(b.approval_snapshot -> 'payload' -> 'Line',
                  p.payload -> 'Line',
                  '[]'::jsonb)
       ) with ordinality as e(elem, n)
  left join public.quickbooks_accounts acc
    on acc.connection_id = b.qbo_connection_id
   and acc.qbo_account_id = e.elem -> 'JournalEntryLineDetail' -> 'AccountRef' ->> 'value'
  left join public.quickbooks_locations loc
    on loc.connection_id = b.qbo_connection_id
   and loc.qbo_location_id = e.elem -> 'JournalEntryLineDetail' -> 'DepartmentRef' ->> 'value';

comment on view public.accounting_journal_lines_v is
  'Every journal line SILO holds, both kinds, in one shape: hand-written and generated adjustments from their stored lines, and card/bank batches from the frozen approval snapshot that was posted to QuickBooks, or from the posting''s own payload for a batch posted before snapshots existed (lines_basis says which). signed_amount is positive for a debit and negative for a credit, so a balanced entry sums to zero. A batch still in draft or categorized has no snapshot and so no rows here -- it is not a journal yet; Accounting close status counts those. Join accounting_journal_sources_v on journal_id for the records the entry was built from. security_invoker, so RLS decides what is visible. 20261113200000.';

grant select on public.accounting_journal_lines_v to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. The records behind each entry
-- ──────────────────────────────────────────────────────────────────────────
create or replace view public.accounting_journal_sources_v
with (security_invoker = true) as
with adj as (
  select
    a.id,
    a.company_entity_id,
    a.entry_date,
    a.memo,
    a.status,
    -- accounting_source was added after the first entries were written, so
    -- 2026-08's depreciation and amortization carry it as NULL and would
    -- otherwise lose their breakdown. Only the two UNAMBIGUOUS context
    -- prefixes are recovered. 'accounting-export:' is deliberately NOT one of
    -- them: both a Shopify summary and a prepaid amortization have been
    -- written with it, and attributing the wrong sources to an entry is worse
    -- than attributing none.
    coalesce(
      a.accounting_source,
      case
        when a.source_context like 'fixed-assets:depreciation%' then 'fixed_asset_depreciation'
        when a.source_context like 'schedules:prepaid%'         then 'prepaid_amortization'
      end
    ) as accounting_source,
    a.source_context,
    a.accounting_source_ref,
    -- The entry's period. First YYYY-MM found in the explicit ref, then in
    -- the context string, then the entry date's own month. Exposed on every
    -- row, so a recomputed source is never read over an assumed window.
    coalesce(
      -- Both patterns are anchored and month-bounded on purpose. A loose
      -- (\d{4}-\d{2}) matched inside a UUID ref -- 'b8fefafc-e399-41ef-8235-
      -- 800be699b9f3' yielded "8235-80" and to_date raised, taking the whole
      -- view down. accounting_source_ref IS the period when it is one, so it
      -- is anchored at both ends; source_context carries it as a suffix.
      to_date(substring(coalesce(a.accounting_source_ref, '') from '^(\d{4}-(?:0[1-9]|1[0-2]))$'), 'YYYY-MM'),
      to_date(substring(coalesce(a.source_context, '')      from  '(\d{4}-(?:0[1-9]|1[0-2]))$'), 'YYYY-MM'),
      date_trunc('month', a.entry_date)::date
    ) as period_start
  from public.journal_adjustments a
),
adjp as (
  select adj.*, (adj.period_start + interval '1 month')::date - 1 as period_end
    from adj
)

-- ── card / bank batch: one row per coded line of each transaction ─────────
select
  b.company_entity_id,
  b.id                                     as journal_id,
  'card_batch'::text                       as kind,
  b.entry_date,
  'transactions'::text                     as accounting_source,
  b.status,
  b.period_start,
  b.period_end,
  case when cl.is_split then 'card_split_line' else 'card_transaction' end as source_kind,
  cl.transaction_id::text                  as source_id,
  cl.txn_date                              as source_date,
  coalesce(nullif(t.clean_merchant, ''), nullif(t.merchant, ''), cl.description) as source_label,
  cl.description                           as source_detail,
  cl.qbo_account_id,
  acc.name                                 as qbo_account_name,
  cl.qbo_location_id,
  loc.name                                 as qbo_location_name,
  cl.amount,
  null::numeric as gross, null::numeric as discounts, null::numeric as refunds,
  null::numeric as shipping, null::numeric as taxes,
  'as_posted'::text                        as source_basis
from public.card_import_batches b
join public.card_coding_effective_lines cl
  on cl.batch_id = b.id
 and cl.company_entity_id = b.company_entity_id
join public.card_transactions t
  on t.id = cl.transaction_id
left join public.quickbooks_accounts acc
  on acc.connection_id = b.qbo_connection_id and acc.qbo_account_id = cl.qbo_account_id
left join public.quickbooks_locations loc
  on loc.connection_id = b.qbo_connection_id and loc.qbo_location_id = cl.qbo_location_id
-- Only a batch that is actually a journal, matching accounting_journal_lines_v
-- exactly: an approved/posted batch has the frozen snapshot, an older posted
-- one has its posting payload, and a draft has neither and is not an entry.
where b.approval_snapshot -> 'payload' -> 'Line' is not null
   or exists (select 1 from public.quickbooks_journal_postings p
               where p.id = b.posting_id and p.payload -> 'Line' is not null)

union all

-- ── Shopify monthly summary: the sales days behind it ─────────────────────
select
  a.company_entity_id,
  a.id,
  'journal_adjustment'::text,
  a.entry_date,
  a.accounting_source,
  a.status,
  a.period_start,
  a.period_end,
  'shopify_sales_day'::text,
  (v.location_tag || ':' || v.day_date::text),
  v.day_date,
  coalesce(max(v.location_name), v.location_tag),
  v.location_tag,
  null::text, null::text, null::text, null::text,
  round(sum(coalesce(v.total_sales, v.sum_total_sales, 0))::numeric, 2),
  round(sum(coalesce(v.total_gross_sales, 0))::numeric, 2),
  round(sum(coalesce(v.total_discounts, 0))::numeric, 2),
  round(sum(coalesce(v.total_refunds, 0))::numeric, 2),
  round(sum(coalesce(v.shipping, v.sum_shipping, 0))::numeric, 2),
  round(sum(coalesce(v.taxes, v.sum_taxes, 0))::numeric, 2),
  'recomputed'::text
from adjp a
join public.sales_by_day_verification_v v
  on v.company_entity_id = a.company_entity_id
 and v.day_date >= a.period_start
 and v.day_date <= a.period_end
where a.accounting_source = 'shopify_monthly'
group by a.company_entity_id, a.id, a.entry_date, a.accounting_source, a.status,
         a.period_start, a.period_end, v.location_tag, v.day_date

union all

-- ── Shopify monthly summary: the payouts whose fees it books ──────────────
select
  a.company_entity_id,
  a.id,
  'journal_adjustment'::text,
  a.entry_date,
  a.accounting_source,
  a.status,
  a.period_start,
  a.period_end,
  'shopify_payout'::text,
  po.payout_id::text,
  po.payout_date,
  po.shop_domain,
  'Payout ' || po.payout_id::text || ' · net ' || round(coalesce(po.amount_net, 0), 2)::text,
  null::text, null::text, null::text, null::text,
  round(coalesce(po.charges_fee, 0) + coalesce(po.refunds_fee, 0)
        + coalesce(po.adjustments_fee, 0), 2),
  null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
  'recomputed'::text
from adjp a
join public.shopify_payouts po
  on po.company_entity_id = a.company_entity_id
 and po.payout_date >= a.period_start
 and po.payout_date <= a.period_end
where a.accounting_source = 'shopify_monthly'

union all

-- ── prepaid amortization: the schedule items for that period ──────────────
select
  a.company_entity_id,
  a.id,
  'journal_adjustment'::text,
  a.entry_date,
  a.accounting_source,
  a.status,
  a.period_start,
  a.period_end,
  'prepaid_schedule_item'::text,
  am.schedule_item_id::text,
  am.period_start,
  am.label,
  'Period ' || am.period_no::text || ' of ' || am.months::text,
  am.qbo_expense_account_id,
  null::text,
  null::text,
  null::text,
  round(am.period_amount, 2),
  null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
  'recomputed'::text
from adjp a
join public.schedule_item_amortization_v am
  on am.company_entity_id = a.company_entity_id
 and am.period_start >= a.period_start
 and am.period_start <= a.period_end
 -- The SAME eligibility the posting builder applies (buildAmortLines in
 -- v2/schedules.html): prepaid schedules only, never a closed one, and no row
 -- the builder would have skipped. The amortization view generates rows for
 -- every schedule type and status, so without this a deferred-revenue
 -- schedule in the same month is attributed to the prepaid journal as if it
 -- were behind it. 'recomputed' says the figures are today's, not that the
 -- POPULATION may differ -- a source the builder could never have used is a
 -- wrong answer, not a stale one. (Raised in review on PR #1278.)
 and am.schedule_type = 'prepaid'
 and am.status is distinct from 'closed'
 and am.period_amount > 0.004          -- builder: `if (amt <= 0.004) continue;`
 and am.qbo_expense_account_id is not null  -- builder reports these unmapped and posts no line
where a.accounting_source = 'prepaid_amortization'

union all

-- ── fixed-asset depreciation: the assets for that period ──────────────────
select
  a.company_entity_id,
  a.id,
  'journal_adjustment'::text,
  a.entry_date,
  a.accounting_source,
  a.status,
  a.period_start,
  a.period_end,
  'fixed_asset'::text,
  d.fixed_asset_id::text,
  d.period_start,
  d.label,
  'Period ' || d.period_no::text || ' of ' || d.months::text,
  d.qbo_depreciation_expense_account_id,
  null::text,
  null::text,
  null::text,
  round(d.period_amount, 2),
  null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
  'recomputed'::text
from adjp a
join public.fixed_asset_depreciation_v d
  on d.company_entity_id = a.company_entity_id
 and d.period_start >= a.period_start
 and d.period_start <= a.period_end
 -- Same rule, from buildDepreciationLines in v2/fixed-assets.html. Note the
 -- near-zero test is ABS here and not in the prepaid builder above: that
 -- difference is deliberate there (a contra-asset month is a negative
 -- period_amount by design), so it is mirrored rather than tidied.
 and d.status is distinct from 'closed'
 and abs(d.period_amount) > 0.004
 and d.qbo_depreciation_expense_account_id is not null
 and d.qbo_accum_depreciation_account_id is not null
where a.accounting_source = 'fixed_asset_depreciation'

union all

-- ── reclass: the one transaction being moved ──────────────────────────────
select
  a.company_entity_id,
  a.id,
  'journal_adjustment'::text,
  a.entry_date,
  a.accounting_source,
  a.status,
  a.period_start,
  a.period_end,
  'card_reclass_transaction'::text,
  rc.transaction_id::text,
  t.txn_date,
  coalesce(nullif(t.clean_merchant, ''), nullif(t.merchant, ''), t.description),
  coalesce(rc.from_qbo_account_name, rc.from_qbo_account_id) || ' → '
    || coalesce(rc.to_qbo_account_name, rc.to_qbo_account_id),
  rc.to_qbo_account_id,
  rc.to_qbo_account_name,
  rc.to_qbo_location_id,
  rc.to_qbo_location_name,
  round(rc.amount, 2),
  null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
  'as_posted'::text
from adjp a
join public.card_transaction_reclasses rc
  on rc.adjustment_id = a.id
 and rc.company_entity_id = a.company_entity_id
join public.card_transactions t
  on t.id = rc.transaction_id
where a.accounting_source = 'card_reclass';

comment on view public.accounting_journal_sources_v is
  'The records behind each journal entry, one row per source record, carrying the entry''s identity so it joins accounting_journal_lines_v on journal_id. A card/bank batch gives its coded transaction lines (a split shows its lines); a monthly Shopify summary gives each location''s sales day and each payout''s fee; prepaid and depreciation entries give the schedule items and assets for the period; a reclass gives the transaction moved. READ source_basis BEFORE COMPARING: as_posted rows are frozen with the entry; recomputed rows are today''s data read over period_start..period_end, so a difference against the entry is a finding, not an error, and recomputed rows are never what was posted -- the entry''s own figures are in accounting_journal_lines_v. A hand-written adjustment has no source and so no rows, which is the honest answer rather than a guess. security_invoker, so RLS decides what is visible. 20261113200000.';

grant select on public.accounting_journal_sources_v to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. One continuous ledger across the migration cut-over
-- ──────────────────────────────────────────────────────────────────────────
-- Blake, 2026-11-13: "if they migrated to silo mid year say July, this would
-- show pre bank details jan-june, then start aggregating silo batches into the
-- recon ... trying to build out recon reports for accounting without a bunch
-- of toggling or manually mashing."
--
-- Both halves already existed and nothing joined them. `qbo_history_lines`
-- holds the general ledger a company kept in QuickBooks BEFORE it moved to
-- SILO -- line by line, not one-liners (Baseballism: Jan 2023 through
-- 2026-07-31, 9,528 lines in January 2026 alone, with transaction type,
-- document number, counterparty, memo and split account). The views above
-- hold what SILO posted after. A bot asked to reconcile a year that spans the
-- move had to know both existed, find the boundary, and avoid double-counting
-- an overlap. This view is that one stream.
--
-- THE SIGN CONVERSION IS THE WHOLE RISK HERE, so it is proved rather than
-- assumed. `qbo_history_lines.natural_amount` is in the ACCOUNT'S NATURAL
-- SIGN (the catalog says so, and 20260913022606 stores the GL export's own
-- Amount column) -- income positive means a credit, expense positive means a
-- debit. Reading it as a debit-signed number silently flips every liability,
-- equity and income line, which in a reconciliation is worse than no view at
-- all. The map below is QuickBooks' complete AccountType enum, split by its
-- natural side, and it is CHECKED on production: converting with it, all
-- 28,559 multi-line imported transactions balance to zero, against 20,192 on
-- the raw natural amount, with no unmapped account type. A tie-out keeps that
-- true. An account type the map does not know leaves `signed_amount`,
-- `posting_type` and `amount` NULL -- never a guessed side.
--
-- `cutover_on` is on every row, so the boundary is a fact the reader can see
-- rather than something they infer from where the rows stop. It is derived,
-- never a constant: the company's `silo_takeover_on`, else its
-- `accounting_start_date`, else the earliest entry SILO actually posted. A
-- company with no imported history simply has no `qbo_history` rows, and one
-- that never migrated has no `silo` rows; neither case needs a branch.
--
-- Imported rows are taken only BEFORE the cut-over, which is what makes the
-- two halves add up instead of overlapping. Nothing is quietly dropped by
-- that: the tie-out "no imported history sits past the cut-over" counts what
-- the rule would exclude and fails if it is ever more than none.
--
-- One thing a reader MUST be told rather than left to infer: the imported
-- half is visible only to a finance user. `qbo_history_lines`' own RLS policy
-- requires `can_manage_journal_entries()` or `is_exec_or_owner()` on top of
-- the company scope, and this view is security_invoker, so for anyone else
-- the view simply starts at the cut-over. That is the correct behaviour and
-- it is NOT a gap in the data -- which is why the catalog description says
-- so, so a bot reports "you do not have access to the imported history"
-- rather than "the company has no records before August".
--
-- Excluded on purpose: `row_kind = 'zero_amount'` (the GL export's
-- running-balance artifacts, 3,642 of them, which carry no amount) and
-- `row_kind = 'opening'` (712 rows with NO date -- opening balances, which
-- are a position, not activity, and cannot sit on a timeline).
-- `ledger_entries` is excluded too: it records the same card transactions the
-- batches post, so a ledger built from both would count them twice.
create or replace view public.accounting_ledger_v
with (security_invoker = true) as
with posted as (
  -- A GENERAL LEDGER holds what was posted, and nothing else. The lines view
  -- above is deliberately all-state, because a reconciler starts from "which
  -- entries do not tie" and a draft that will not balance is exactly what they
  -- are looking for. Summing that same all-state set into monthly account
  -- totals is a different thing and it is wrong: a saved $100 draft, or an
  -- approved reclass not yet sent to QuickBooks, would move a month's totals
  -- although nothing has been booked, and a voided entry would keep counting.
  -- The month-by-month report groups status away, so the reader could not even
  -- see it. (Raised in review on PR #1278.)
  --
  -- `status = 'posted'` is SILO's own word for it, and the posting row is
  -- checked too: an entry SILO believes it posted but whose QuickBooks posting
  -- later failed or was voided is not in the books either. coalesce, because a
  -- posted entry need not have a posting row at all.
  select l.*
    from public.accounting_journal_lines_v l
   where l.status = 'posted'
     and coalesce(l.posting_status, 'posted') not in ('failed', 'voided')
), cutover as (
  select
    coalesce(
      -- max(), not a bare scalar: a second settings row for one company would
      -- make a scalar subquery RAISE, taking the whole ledger down. There is
      -- one row per company today; the ledger does not depend on that holding.
      (select max(s.silo_takeover_on) from public.accounting_settings s
        where s.company_entity_id = public.active_company_id()),
      (select max(s.accounting_start_date) from public.accounting_settings s
        where s.company_entity_id = public.active_company_id()),
      -- POSTED entries only, for the same reason and one more: this date is
      -- the floor on imported history, so a draft dated before the real
      -- cut-over would silently hide a month of QuickBooks history behind an
      -- entry nobody booked. (The 'no imported history is hidden' tie-out
      -- would go red, which is the alarm, not the fix.)
      (select min(l.entry_date) from posted l)
    ) as on_date
)
-- ── What SILO posted ──────────────────────────────────────────────────────
select
  l.company_entity_id,
  'silo'::text                           as origin,
  l.entry_date,
  (select on_date from cutover)          as cutover_on,
  l.qbo_account_id,
  l.qbo_account_name,
  null::text                             as account_type,
  l.posting_type,
  l.amount,
  l.signed_amount,
  l.qbo_location_id,
  l.qbo_location_name,
  l.entity_name                          as counterparty,
  l.qbo_doc_number                       as document_number,
  l.kind                                 as transaction_type,
  l.memo,
  l.description,
  l.journal_id::text                     as transaction_ref,
  l.journal_id,
  l.status,
  l.posting_status,
  true                                   as has_source_detail
from posted l

union all

-- ── What the company kept in QuickBooks before it moved ───────────────────
select
  h.company_entity_id,
  'qbo_history'::text,
  h.transaction_date,
  (select on_date from cutover),
  h.qbo_account_id,
  h.account_name,
  h.account_type,
  case when sgn.dr is null then null when sgn.dr >= 0 then 'Debit' else 'Credit' end,
  case when sgn.dr is null then null else round(abs(sgn.dr), 2) end,
  case when sgn.dr is null then null else round(sgn.dr, 2) end,
  null::text,
  null::text,
  nullif(h.counterparty, ''),
  nullif(h.document_number, ''),
  h.transaction_type,
  nullif(h.memo, ''),
  nullif(h.split_account_name, ''),
  h.qbo_transaction_id,
  null::uuid,
  'posted'::text,
  'posted'::text,
  -- SILO never held the records behind these; QuickBooks did. Saying so is
  -- the point of the column.
  false
from public.qbo_history_lines h
cross join lateral (
  select case
    when h.account_type in ('Bank', 'Accounts Receivable', 'Other Current Asset',
                            'Fixed Asset', 'Other Asset', 'Expense',
                            'Other Expense', 'Cost of Goods Sold')
      then h.natural_amount
    when h.account_type in ('Accounts Payable', 'Credit Card', 'Other Current Liability',
                            'Long Term Liability', 'Other Liability', 'Equity',
                            'Income', 'Other Income')
      then -h.natural_amount
  end as dr
) sgn
where h.row_kind = 'transaction'
  and h.transaction_date is not null
  and h.transaction_date < coalesce((select on_date from cutover), 'infinity'::date);

comment on view public.accounting_ledger_v is
  'One continuous general ledger across the move to SILO, so a reconciliation that spans the cut-over needs no stitching. origin is ''qbo_history'' for the ledger the company kept in QuickBooks before it migrated (line by line, with transaction_type, document_number, counterparty, memo and the split account) and ''silo'' for every line SILO has POSTED since -- a draft, an approved-but-unsent entry and a voided one are all absent, because a general ledger holds what was booked (the all-state register is accounting_journal_lines_v). cutover_on is on every row and is derived from the company''s silo_takeover_on, else accounting_start_date, else the earliest entry SILO posted -- imported rows are taken only before it, so the two halves add up rather than overlap. signed_amount is +debit/-credit on BOTH sides: imported amounts are stored in the account''s natural sign and are converted here by QuickBooks'' account-type map, which is proved by a tie-out (every multi-line imported transaction balances once converted); an account type the map does not know leaves posting_type, amount and signed_amount NULL rather than guessing a side. has_source_detail is true where SILO holds the records behind the line -- join accounting_journal_sources_v on journal_id for them -- and false for imported history, where QuickBooks holds them. Opening balances and the export''s running-balance rows are excluded: a position is not activity. The imported half is visible only to a finance user: qbo_history_lines'' own RLS adds can_manage_journal_entries() / is_exec_or_owner() on top of the company scope, so for anyone else the ledger simply starts at the cut-over -- that is access, not an absence of records. security_invoker, so RLS decides what is visible. 20261113200000.';

grant select on public.accounting_ledger_v to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. So a bot finds them: Ask SILO's catalog, which describe_tables serves
-- ──────────────────────────────────────────────────────────────────────────
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  description = $d$Every journal line SILO holds, both kinds, in one shape. Columns: journal_id, kind ('journal_adjustment' or 'card_batch'), entry_date, memo, accounting_source, status, posting_status, qbo_journal_entry_id, qbo_doc_number, line_no, qbo_account_id / qbo_account_name, posting_type ('Debit' / 'Credit', title-cased), amount, signed_amount (positive debit, negative credit, so a balanced entry sums to 0), location, entity and description. lines_basis is 'stored' for an adjustment, and for a batch 'approval_snapshot' (the frozen array that was posted to QuickBooks) or 'posting_payload' (the posting's own copy, for a batch posted before snapshots existed). A batch still in draft or categorized is NOT a journal yet and has no rows here; Accounting close status counts those. THIS IS THE LEDGER AS SILO POSTED IT -- for what each entry was built from, join accounting_journal_sources_v on journal_id.$d$,
  keywords = array['journal entries','journal lines','general ledger','gl','debits and credits','reconcile','accounting close','posted to quickbooks','card batch','adjustment'],
  updated_at = now()
where relname = 'accounting_journal_lines_v';

update public.silo_chat_schema_catalog set
  description = $d$The records behind each journal entry -- the breakdown SILO used when it posted. One row per source record, carrying journal_id so it joins accounting_journal_lines_v. source_kind is 'card_transaction' / 'card_split_line' (the bank and card rows in a batch), 'shopify_sales_day' (one row per location per day, with gross, discounts, refunds, shipping and taxes), 'shopify_payout' (amount is that payout's fee), 'prepaid_schedule_item', 'fixed_asset' or 'card_reclass_transaction'. The schedule and asset branches apply the SAME eligibility the posting builders do (prepaid schedules only, never closed, nothing the builder would have skipped as near-zero or unmapped), so a schedule of another type in the same month is never attributed to the entry. ALWAYS READ source_basis: 'as_posted' rows are frozen with the entry; 'recomputed' rows are today's data read over period_start..period_end, so they are the other side of a reconciliation and never what was posted -- the posted figures are in accounting_journal_lines_v. An entry with no stored breakdown (a hand-written manual_adjustment) has no rows here, which means no source, not missing data.$d$,
  keywords = array['reconcile','reconciliation','journal breakdown','what is behind this entry','drill down','source of a journal','tie out','audit trail','backup'],
  updated_at = now()
where relname = 'accounting_journal_sources_v';

update public.silo_chat_schema_catalog set
  description = $d$One continuous general ledger across the move to SILO, so a reconciliation that spans the cut-over needs no stitching. origin is 'qbo_history' for the ledger the company kept in QuickBooks BEFORE it migrated -- line by line, with transaction_type, document_number, counterparty, memo and the split account -- and 'silo' for every line SILO has POSTED since -- a draft, an approved-but-unsent entry and a voided one are all absent, because a general ledger holds what was booked; for the all-state register use accounting_journal_lines_v. cutover_on is on every row and is derived (the company's silo_takeover_on, else accounting_start_date, else the earliest entry SILO posted); imported rows are taken only before it, so the two halves add up rather than overlap. signed_amount is +debit/-credit on BOTH sides: imported amounts are stored in the account's natural sign and are converted here by QuickBooks' account-type map, and an account type the map does not know leaves posting_type, amount and signed_amount NULL rather than guessing a side. has_source_detail is true where SILO holds the records behind the line -- join accounting_journal_sources_v on journal_id -- and false for imported history, where QuickBooks holds them. Opening balances and the export's running-balance rows are excluded: a position is not activity. If the ledger starts at cutover_on with no 'qbo_history' rows at all, the connected user may simply not have finance access to the imported history (qbo_history_lines requires can_manage_journal_entries() or is_exec_or_owner()) -- say that, rather than reporting that the company has no records before the cut-over. USE THIS for a balance sheet or GL reconciliation covering a period that starts before the company moved to SILO.$d$,
  keywords = array['general ledger','gl','full year','balance sheet','reconcile across the migration','before silo','quickbooks history','cutover','continuous ledger','trial balance'],
  updated_at = now()
where relname = 'accounting_ledger_v';

do $$
declare v_missing text[];
begin
  select array_agg(r order by r) into v_missing
    from unnest(array['accounting_journal_lines_v','accounting_journal_sources_v','accounting_ledger_v']) r
   where not exists (select 1 from public.silo_chat_schema_catalog k
                      where k.relname = r and not k.is_hidden
                        and coalesce(btrim(k.description), '') <> '');
  if v_missing is not null then
    raise exception 'accounting drill-down views absent or undescribed in silo_chat_schema_catalog: %',
      array_to_string(v_missing, ', ');
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. The report: one row per entry, with how it ties to its source
-- ──────────────────────────────────────────────────────────────────────────
-- Deliberately one row per ENTRY, not per line: a reconciler starts from
-- "which entries do not tie", then queries the two views for the one that
-- does not. source_total is blank where there is no stored breakdown, and
-- source_basis says whether a difference is meaningful.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer,
   queries_run, parameters, columns_metadata)
values
  ('c7000000-0000-4000-a000-000000000004', null, null, 'system', 'company',
   'Journal entries and their sources',
   'Every journal entry SILO holds over the period -- hand-written adjustments and card/bank batches alike -- with its debits, credits, whether it is balanced, where it is in the approval and QuickBooks path, and the records SILO built it from. Start here, then drill into one entry by its journal_id in accounting_journal_lines_v (its lines) and accounting_journal_sources_v (its sources). source_rows, source_kinds and source_total are blank for an entry with no stored breakdown -- a hand-written adjustment has none, and that is an answer, not missing data. source_total is the plain sum of the source records'' amounts, so it is comparable to the entry only within one source_kind: a Shopify monthly entry mixes sales days with payout fees and books both, which is why source_kinds is shown next to it. Read source_basis before treating any difference as an error: as_posted sources are frozen with the entry, recomputed sources are today''s data read over period_start..period_end, so a difference there is what reconciliation is for.',
   null, null,
   array[$q$with lines as (
  select l.journal_id, l.kind, l.entry_date, l.memo, l.accounting_source,
         l.status, l.posting_status, l.qbo_journal_entry_id, l.qbo_doc_number,
         l.lines_basis,
         count(*) as line_count,
         round(sum(case when l.posting_type = 'Debit' then l.amount else 0 end), 2) as debits,
         round(sum(case when l.posting_type = 'Credit' then l.amount else 0 end), 2) as credits
    from public.accounting_journal_lines_v l
   where l.entry_date >= {{date_from}} and l.entry_date <= {{date_to}}
   group by 1,2,3,4,5,6,7,8,9,10
), src as (
  select s.journal_id,
         count(*) as source_rows,
         string_agg(distinct s.source_kind, ', ' order by s.source_kind) as source_kinds,
         -- 'mixed' rather than one of them: an entry whose sources are partly
         -- frozen and partly recomputed must not read as wholly either.
         case when count(distinct s.source_basis) > 1 then 'mixed'
              else min(s.source_basis) end as source_basis,
         min(s.period_start) as period_start,
         max(s.period_end) as period_end,
         round(sum(s.amount), 2) as source_total
    from public.accounting_journal_sources_v s
   group by 1
)
select l.entry_date,
       l.kind,
       l.memo,
       l.journal_id,
       l.accounting_source,
       l.status,
       l.posting_status,
       l.qbo_doc_number,
       l.line_count,
       l.debits,
       l.credits,
       round(l.debits - l.credits, 2) as out_of_balance,
       s.source_rows,
       s.source_kinds,
       s.source_basis,
       s.period_start,
       s.period_end,
       s.source_total,
       'https://get-silo.com/v2/accounting-books.html#register' as open_in_silo
  from lines l
  left join src s on s.journal_id = l.journal_id
 order by l.entry_date desc, l.kind, l.memo$q$],
   '[{"key":"date_from","type":"date","label":"From","default":"today-180d","date_basis":"company"},
     {"key":"date_to","type":"date","label":"Through","default":"today","date_basis":"company"}]'::jsonb,
   '{"entry_date":{"label":"Entry date","semantic":"date","source":"authored"},
     "kind":{"label":"Kind","source":"authored"},
     "memo":{"label":"Memo","source":"authored"},
     "journal_id":{"label":"Journal id","source":"authored"},
     "accounting_source":{"label":"Built by","source":"authored"},
     "status":{"label":"Status","source":"authored"},
     "posting_status":{"label":"QuickBooks","source":"authored"},
     "qbo_doc_number":{"label":"QBO doc #","source":"authored"},
     "line_count":{"label":"Lines","semantic":"count","source":"authored"},
     "debits":{"label":"Debits","semantic":"currency","source":"authored"},
     "credits":{"label":"Credits","semantic":"currency","source":"authored"},
     "out_of_balance":{"label":"Out of balance","semantic":"currency","source":"authored"},
     "source_rows":{"label":"Source records","semantic":"count","source":"authored"},
     "source_kinds":{"label":"Source kinds","source":"authored"},
     "source_basis":{"label":"Source basis","source":"authored"},
     "period_start":{"label":"Period from","semantic":"date","source":"authored"},
     "period_end":{"label":"Period through","semantic":"date","source":"authored"},
     "source_total":{"label":"Source total","semantic":"currency","source":"authored"},
     "open_in_silo":{"label":"Open in SILO","semantic":"link","source":"authored"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  columns_metadata = excluded.columns_metadata,
  archived_at = null, updated_at = now();

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Tie-outs. Every system report needs one (verify_v2_schema enforces it).
-- ──────────────────────────────────────────────────────────────────────────
-- The checks assert invariants that hold whatever the data does, never a
-- figure that legitimately moves:
--   * every entry in the report balances (debits = credits). This is the
--     property a reconciler relies on, and the one a bad snapshot expansion
--     or a lost line would break.
--   * the report's entry count ties to the base tables, counted a DIFFERENT
--     way from how the view finds a batch's lines: an adjustment with lines,
--     and a batch once it is approved or posted. A check that mirrored the
--     view's own coalesce would agree with it however broken it was; this one
--     fails when a batch that is in QuickBooks stops producing lines, which
--     is the hole this migration closed for the 2026-08 postings. A grouping
--     that fans out or drops rows fails here too.
do $$
declare
  r     record;
  guard text;
begin
  for r in select * from public.silo_chat_saved_reports
            where id = 'c7000000-0000-4000-a000-000000000004'
              and source = 'system' and company_entity_id is null
  loop
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);
    delete from public.silo_report_tieouts where report_id = r.id;

    insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
    (r.id, 'Every journal entry balances', 'reconciliation',
     format('with report as materialized (%s) select case when %s then count(*) filter (where abs(coalesce(out_of_balance, 0)) > 0.005) end as left_value, 0::numeric as right_value from report',
            replace(replace(r.queries_run[1], '{{date_from}}', '((select public.silo_business_today()) - 180)'),
                    '{{date_to}}', '(select public.silo_business_today())'),
            guard),
     0,
     'A journal entry whose debits do not equal its credits. Fails if the approval snapshot is expanded wrongly or an adjustment line is lost. NO DATA means the report changed and this check must be regenerated in the same migration.'),

    (r.id, 'Entry count ties to the base tables', 'reconciliation',
     format('with report as materialized (%s) select case when %s then count(*) end as left_value, '
       || '((select count(*) from public.journal_adjustments a where a.company_entity_id = (select public.active_company_id()) '
       || 'and a.entry_date >= (select public.silo_business_today()) - 180 and a.entry_date <= (select public.silo_business_today()) '
       || 'and exists (select 1 from public.journal_adjustment_lines jl where jl.adjustment_id = a.id)) '
       || '+ (select count(*) from public.card_import_batches b where b.company_entity_id = (select public.active_company_id()) '
       || 'and b.entry_date >= (select public.silo_business_today()) - 180 and b.entry_date <= (select public.silo_business_today()) '
       || 'and b.status in (''approved'', ''posted'')))::numeric as right_value from report',
            replace(replace(r.queries_run[1], '{{date_from}}', '((select public.silo_business_today()) - 180)'),
                    '{{date_to}}', '(select public.silo_business_today())'),
            guard),
     0,
     'Counts the base tables directly, and deliberately NOT the way the view finds a batch''s lines: a batch is counted here once it is approved or posted, so a batch that is in QuickBooks but has stopped producing lines -- the exact hole this migration closed for the 2026-08 postings -- fails rather than quietly agreeing with the view. A grouping that fans out or drops rows fails too. NO DATA means the report changed and this check must be regenerated in the same migration.');
  end loop;

  if (select count(*) from public.silo_report_tieouts
       where report_id = 'c7000000-0000-4000-a000-000000000004') <> 2 then
    raise exception 'journal drill-down tie-outs: expected 2 checks';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7. The recon report: a full year of GL, straight across the cut-over
-- ──────────────────────────────────────────────────────────────────────────
-- Blake, 2026-11-13: "recon reports for accounting without a bunch of
-- toggling or manually mashing." Month by account by origin, over a window
-- that defaults to the last 365 days, so a year that spans the move is one
-- answer rather than two reports stitched by hand. `origin` stays on every
-- row instead of being summed away: a reconciler needs to see WHERE the
-- months change hands, and a month that carries both origins is the
-- cut-over month, not an error.
insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer,
   queries_run, parameters, columns_metadata)
values
  ('c7000000-0000-4000-a000-000000000005', null, null, 'system', 'company',
   'General ledger by month',
   'The general ledger month by month and account by account across the whole period, including the part that predates the company''s move to SILO. origin says where each row came from: ''qbo_history'' is the ledger kept in QuickBooks before the move (imported line by line, so these are real transactions, not one-line summaries) and ''silo'' is what SILO has posted since. cutover_on is the date the two meet and is on every row; a month showing both origins is the month of the move. debits, credits and net are in debit-positive terms on BOTH sides -- imported amounts are stored in the account''s natural sign and converted here. unmapped_lines counts imported lines whose account type SILO could not place on a debit or credit side; those lines are counted but left out of debits, credits and net rather than guessed, so a non-zero value means that month is understated and is worth looking at. For what is behind any SILO-origin line, use the Journal entries and their sources report or accounting_journal_sources_v; for an imported line the records are in QuickBooks, which is what has_source_detail records in accounting_ledger_v.',
   null, null,
   array[$q$select date_trunc('month', g.entry_date)::date as month,
       g.origin,
       g.cutover_on,
       coalesce(g.qbo_account_name, '(unnamed account)') as account_name,
       g.account_type,
       count(*) as lines,
       count(*) filter (where g.signed_amount is null) as unmapped_lines,
       round(sum(case when g.posting_type = 'Debit'  then g.amount else 0 end), 2) as debits,
       round(sum(case when g.posting_type = 'Credit' then g.amount else 0 end), 2) as credits,
       round(sum(coalesce(g.signed_amount, 0)), 2) as net
  from public.accounting_ledger_v g
 where g.entry_date >= {{date_from}} and g.entry_date <= {{date_to}}
 group by 1,2,3,4,5
 order by 1 desc, g.origin, account_name$q$],
   '[{"key":"date_from","type":"date","label":"From","default":"today-365d","date_basis":"company"},
     {"key":"date_to","type":"date","label":"Through","default":"today","date_basis":"company"}]'::jsonb,
   '{"month":{"label":"Month","semantic":"date","source":"authored"},
     "origin":{"label":"Origin","source":"authored"},
     "cutover_on":{"label":"Moved to SILO","semantic":"date","source":"authored"},
     "account_name":{"label":"Account","source":"authored"},
     "account_type":{"label":"Account type","source":"authored"},
     "lines":{"label":"Lines","semantic":"count","source":"authored"},
     "unmapped_lines":{"label":"Unmapped lines","semantic":"count","source":"authored"},
     "debits":{"label":"Debits","semantic":"currency","source":"authored"},
     "credits":{"label":"Credits","semantic":"currency","source":"authored"},
     "net":{"label":"Net (debit positive)","semantic":"currency","source":"authored"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  columns_metadata = excluded.columns_metadata,
  archived_at = null, updated_at = now();

-- Three checks, each on the thing that would actually go wrong:
--   * the sign conversion. If the account-type map is wrong for one type,
--     every imported transaction touching it stops balancing. This is the
--     check that makes the conversion safe to rely on rather than asserted.
--   * an account type the map does not know. Those lines are deliberately
--     left out of the totals rather than guessed, so the month is
--     understated and a human has to be told -- a red check is the telling.
--   * the report's own grouping, against the view read directly. A fan-out
--     or a dropped origin moves one side and not the other.
--   * imported lines the cut-over would hide. Taking history only BEFORE the
--     cut-over is what stops the two eras double-counting; this is what
--     stops that rule quietly deleting rows from the answer.
do $$
declare
  r     record;
  guard text;
  qry   text;
begin
  for r in select * from public.silo_chat_saved_reports
            where id = 'c7000000-0000-4000-a000-000000000005'
              and source = 'system' and company_entity_id is null
  loop
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);
    qry := replace(replace(r.queries_run[1], '{{date_from}}', '((select public.silo_business_today()) - 365)'),
                   '{{date_to}}', '(select public.silo_business_today())');
    delete from public.silo_report_tieouts where report_id = r.id;

    insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
    (r.id, 'Imported history balances after conversion', 'reconciliation',
     format('select case when %s then (select count(*) from (select g.transaction_ref from public.accounting_ledger_v g '
       || 'where g.origin = ''qbo_history'' and g.entry_date >= (select public.silo_business_today()) - 365 '
       || 'and g.entry_date <= (select public.silo_business_today()) group by g.transaction_ref '
       || 'having count(*) > 1 and count(*) filter (where g.signed_amount is null) = 0 '
       || 'and abs(sum(g.signed_amount)) > 0.005) t) end as left_value, 0::numeric as right_value',
            guard),
     0,
     'An imported QuickBooks transaction whose lines no longer sum to zero once converted from the account''s natural sign to debits and credits. This is the check that keeps the account-type map honest: get one type''s side wrong and every transaction touching it fails here. Single-line rows and transactions with an unmapped line are excluded, the second being the next check''s job.'),

    (r.id, 'Every imported account type has a side', 'reconciliation',
     format('select case when %s then (select count(*) from public.accounting_ledger_v g '
       || 'where g.origin = ''qbo_history'' and g.signed_amount is null '
       || 'and g.entry_date >= (select public.silo_business_today()) - 365 '
       || 'and g.entry_date <= (select public.silo_business_today())) end as left_value, 0::numeric as right_value',
            guard),
     0,
     'An imported line whose QuickBooks account type is not in the debit/credit map, so SILO left its side blank rather than guessing. Those lines are counted but excluded from debits, credits and net, which understates that month -- so this is red on purpose and the fix is to add the type to accounting_ledger_v, not to widen a tolerance.'),

    (r.id, 'Monthly totals tie to the ledger', 'reconciliation',
     format('with report as materialized (%s) select case when %s then round(sum(net), 2) end as left_value, '
       || '(select round(sum(coalesce(g.signed_amount, 0)), 2) from public.accounting_ledger_v g '
       || 'where g.entry_date >= (select public.silo_business_today()) - 365 '
       || 'and g.entry_date <= (select public.silo_business_today())) as right_value from report',
            qry, guard),
     0.01,
     'The report''s net, summed back up, against the ledger view read directly over the same window. A grouping that fans rows out or drops an origin moves one side and not the other. NO DATA means the report changed and this check must be regenerated in the same migration.'),

    -- Guarded like the rest even though it reads the views rather than the
    -- report SQL: verify asserts that EVERY enabled tie-out on a report
    -- carries that report's current fingerprint, so an unguarded one would
    -- read as a check left behind by an older definition.
    (r.id, 'No imported history is hidden by the cut-over', 'reconciliation',
     format('select case when %s then (select count(*) from public.qbo_history_lines h where h.row_kind = ''transaction'' '
       || 'and h.transaction_date is not null '
       || 'and h.transaction_date >= (select public.silo_business_today()) - 365 '
       || 'and h.transaction_date <= (select public.silo_business_today()))::numeric end as left_value, '
       || '(select count(*) from public.accounting_ledger_v g where g.origin = ''qbo_history'' '
       || 'and g.entry_date >= (select public.silo_business_today()) - 365 '
       || 'and g.entry_date <= (select public.silo_business_today()))::numeric as right_value',
            guard),
     0,
     'Imported QuickBooks lines in the window, against the ones the ledger actually shows. The ledger takes imported rows only BEFORE the cut-over so the two eras cannot double-count, and this is what makes that rule safe: if an import reaches past the cut-over date, those lines would vanish from the ledger silently, and instead this goes red. The fix is the cut-over date or the import, never this check.');
  end loop;

  if (select count(*) from public.silo_report_tieouts
       where report_id = 'c7000000-0000-4000-a000-000000000005') <> 4 then
    raise exception 'general ledger by month tie-outs: expected 4 checks';
  end if;
end $$;

commit;
