-- Evidence-only backtest: old vs new history retrieval for card-categorize.
--
-- READ-ONLY. For rows a PERSON coded (coding_source = 'manual'), ask what each
-- retrieval would have put in front of the model -- using only history dated
-- up to that row's own date and never the row itself -- and whether the
-- account history leads with is the account the person chose.
--
-- It does not call the model. It measures the EVIDENCE: how often there is
-- any exact precedent, and how often that precedent agrees with the person.
-- A model can still ignore good evidence or overcome bad; that is a separate
-- measurement and needs model calls.
--
--   old = the pre-20260923140000 service: SILO rows by exact merchant key (no
--         direction), plus ledger lines matched by PAYEE (exact, or whole-word
--         similar) among the newest 5,000 raw window lines only
--   new = card_coding_history_evidence: the same SILO rule plus direction in
--         a bank feed, ledger matched per merchant BEFORE any cap, by payee or
--         memo, deduplicated across snapshots
-- Weights mirror buildEvidence: recency 1 / 0.7 / 0.4 at 6 / 12 / 24 months;
-- ledger exact or memo x0.8, similar x0.4; a candidate needs one exact match.
--
-- Set the company and the sample window in the first CTE.
with params as (
  select '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid co, date '2026-07-01' since, 5000 old_cap
),
target as (
  select t.id, t.txn_date d, t.qbo_account_id human, t.amount,
    public.normalize_merchant(coalesce(t.clean_merchant, t.description)) k,
    case when s.source_type = 'bank' or s.ingest_mode = 'plaid' then case when t.amount < 0 then 'inflow' else 'outflow' end end dir,
    coalesce(b.qbo_connection_id, s.qbo_connection_id) conn
  from card_transactions t join card_import_batches b on b.id = t.batch_id join card_sources s on s.id = b.source_id, params
  where t.company_entity_id = params.co and t.status = 'coded' and t.coding_source = 'manual'
    and t.qbo_account_id is not null and t.txn_date >= params.since and b.status <> 'voided'
),
pairs as materialized (select *, (d - interval '24 months')::date lo from target where k is not null),
silo_all as materialized (
  select t.id, t.qbo_account_id acct, t.txn_date dt, t.amount,
    public.normalize_merchant(coalesce(t.clean_merchant, t.description)) k,
    coalesce(b.qbo_connection_id, s.qbo_connection_id) conn
  from card_transactions t join card_import_batches b on b.id = t.batch_id join card_sources s on s.id = b.source_id, params
  where t.company_entity_id = params.co and t.status = 'coded' and t.qbo_account_id is not null and b.status <> 'voided'
    and (t.coding_source in ('manual','rule') or (t.coding_source = 'ai' and b.status in ('approved','posted')))
),
silo_old as (select p.id tid, a.acct, a.dt, 1.0 w, true exact from pairs p join silo_all a
  on a.k = p.k and a.conn = p.conn and a.id <> p.id and a.dt between p.lo and p.d),
silo_new as (select p.id tid, a.acct, a.dt, 1.0 w, true exact from pairs p join silo_all a
  on a.k = p.k and a.conn = p.conn and a.id <> p.id and a.dt between p.lo and p.d
  where p.dir is null or (p.dir = 'outflow' and a.amount > 0) or (p.dir = 'inflow' and a.amount < 0)),
lines as materialized (
  select h.id, h.qbo_account_id acct, h.account_type, h.transaction_date dt, h.natural_amount, h.counterparty, h.memo,
    h.qbo_transaction_id, im.qbo_connection_id conn
  from qbo_history_lines h join qbo_history_imports im on im.id = h.import_id and im.company_entity_id = h.company_entity_id, params
  where h.company_entity_id = params.co and h.row_kind = 'transaction'
    and h.account_type in ('Expense','Other Expense','Cost of Goods Sold','Fixed Asset','Other Asset','Other Current Asset','Income','Other Income')
),
-- Where the old 5,000-line page stopped: the date of the 5,000th newest raw
-- line in the window. Approximated once for the whole sample (the old read
-- ended at the request's LATEST anchor, so this is generous to it).
old_floor as (select min(dt) floor from (select dt from lines, params order by dt desc limit (select old_cap from params)) x),
payees as materialized (select raw, public.normalize_merchant(raw) n from (select distinct counterparty raw from lines where counterparty is not null) x),
memos as materialized (select raw, public.normalize_merchant(raw) n from (select distinct memo raw from lines where memo is not null) x),
-- Matching runs once per distinct MERCHANT, not per row: the rows are then
-- joined back with their own dates.
keys as materialized (select distinct k from pairs),
payee_hits as (select y.k, y.raw, y.exact from (select distinct k.k, p.raw, (p.n = k.k) exact from keys k join payees p on p.n = k.k
  or (least(length(p.n), length(k.k)) >= 4 and (position(' '||k.k||' ' in ' '||p.n||' ') > 0 or position(' '||p.n||' ' in ' '||k.k||' ') > 0))) y),
memo_hits as (select k.k, m.raw, (m.n = k.k) exact from keys k join memos m on m.n = k.k
  or (length(k.k) >= 4 and position(' '||k.k||' ' in ' '||m.n||' ') > 0)),
key_lines_old as materialized (
  -- raw lines (the old page was not deduplicated before its cap), payee only
  select h.k, l.acct, l.dt, l.conn, case when h.exact then 0.8 else 0.4 end w, h.exact
  from payee_hits h join lines l on l.counterparty = h.raw, old_floor where l.dt >= old_floor.floor
),
key_lines_new as materialized (
  select distinct on (m.k, m.qbo_transaction_id, m.acct, m.dt, m.natural_amount, m.counterparty) m.k, m.acct, m.dt, m.conn, m.account_type, m.w, m.exact
  from (
    select h.k, l.*, case when h.exact then 0.8 else 0.4 end w, h.exact from payee_hits h join lines l on l.counterparty = h.raw
    union all
    select h.k, l.*, case when h.exact then 0.8 else 0.4 end w, h.exact from memo_hits h join lines l on l.memo = h.raw
  ) m
  order by m.k, m.qbo_transaction_id, m.acct, m.dt, m.natural_amount, m.counterparty, m.exact desc
),
ledger_old as (select p.id tid, l.acct, l.dt, l.w, l.exact from pairs p join key_lines_old l
  on l.k = p.k and l.conn = p.conn and l.dt between p.lo and p.d),
ledger_new as (select p.id tid, l.acct, l.dt, l.w, l.exact from pairs p join key_lines_new l
  on l.k = p.k and l.conn = p.conn and l.dt between p.lo and p.d
  where p.dir is distinct from 'outflow' or l.account_type not in ('Income','Other Income')),
ev as (
  select 'old' method, tid, acct, dt, w, exact from silo_old union all select 'old', tid, acct, dt, w, exact from ledger_old
  union all select 'new', tid, acct, dt, w, exact from silo_new union all select 'new', tid, acct, dt, w, exact from ledger_new
),
scored as (
  select e.method, e.tid, e.acct,
    sum(e.w * case when p.d - e.dt <= 183 then 1 when p.d - e.dt <= 365 then 0.7 else 0.4 end) weight,
    bool_or(e.exact) any_exact
  from ev e join pairs p on p.id = e.tid group by 1, 2, 3
),
lead_acct as (
  select distinct on (method, tid) method, tid, acct, weight, any_exact,
    weight / sum(weight) over (partition by method, tid) share
  from scored order by method, tid, weight desc, acct
)
select m.method,
  count(*) rows_tested,
  count(l.tid) filter (where l.any_exact) with_exact_precedent,
  count(l.tid) filter (where l.any_exact and l.acct = p.human) precedent_agrees,
  count(l.tid) filter (where l.any_exact and l.acct <> p.human) precedent_disagrees,
  count(l.tid) filter (where l.any_exact and l.share >= 0.75 and l.acct = p.human) consistent_and_agrees,
  count(l.tid) filter (where l.any_exact and l.share >= 0.75 and l.acct <> p.human) consistent_and_disagrees
from (values ('old'), ('new')) m(method) cross join pairs p
left join lead_acct l on l.method = m.method and l.tid = p.id
group by m.method order by m.method desc;
