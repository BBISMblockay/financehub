-- A paydown is matched to the payment that NAMES it (2026-11-25).
--
-- Until now a candidate was any row on another account that offset the amount
-- inside a date window. On a real bank feed that is not enough: Baseballism's
-- 15,000.00 paydown on the Spark Cash Plus card was offered, with a one-click
-- Confirm, against BOTH "PREAUTHORIZED ACH DEBIT CAPITAL ONE MO..." and
-- "PREAUTHORIZED ACH DEBIT FLEX NET60 FLEX...". The second is a different
-- creditor entirely -- and SILO already knew: the card's Plaid connection is
-- Capital One and the company keeps a separate Flex account whose name is in
-- that description.
--
-- WHAT COUNTS AS A NAME is not a list of issuers -- a list would be a guess
-- about a tenant SILO has never seen. It is built from the company's OWN
-- accounts: every word in a source's display name, its QuickBooks account
-- name, its vendor, its Plaid account and institution name, and its mask. A
-- word is a NAME only where it belongs to exactly ONE of that company's
-- sources, which is what makes it able to tell them apart:
--
--   FLEX        -> only the Flex account          -> names it
--   2008        -> only Spark Cash Plus           -> names it
--   CAPITAL     -> both Capital One cards         -> says nothing
--   BASEBALLISM -> the vendor on three accounts   -> says nothing
--
-- So the rule needs no issuer table, no per-company configuration and no
-- branch on a company: a line of credit, a payable card or a brand new tenant
-- with no Plaid connection at all behaves the same way, and a company whose
-- accounts share every word simply gets no signal rather than a wrong one.
--
-- Three outcomes, and only the first two are ever offered:
--   'named'        the description names this very account      -> offerable
--   'unknown'      it names none of the company's accounts      -> offerable
--   'other_source' it names a DIFFERENT account of this company -> never
--
-- 'unknown' stays offerable on purpose. Most CSV sources have no distinctive
-- word anywhere, and refusing to offer those would take the feature away from
-- everyone who is not on Plaid. What it must never do is out-rank a 'named'
-- one, which is why both pickers order by the signal first.
--
-- The match itself is NOT narrowed: a person who opens the picker still sees
-- every offsetting row, 'other_source' ones last, and the record's integrity
-- trigger is untouched. A name is evidence about which row to offer, never a
-- rule about which pairing is legal -- somebody who knows their own books can
-- still confirm a pair whose words disagree.
--
-- AND ONE PAYMENT CANNOT BE THE ANSWER TWICE. Each row was asked about on its
-- own, so two bank rows could each see the same single paydown and each show a
-- one-click Confirm -- the second press would then be refused, after the fact.
-- A counterpart claimed by more than one row is now contested: still listed,
-- never one-click, for any of them.
--
-- NEW NAMES, and the old ones dropped. These functions gain columns, which a
-- create-or-replace cannot do, and editing an applied migration in place would
-- be worse: apply_all_post_merge.sql re-runs every file IN ORDER, so 20261125080000
-- would meet a changed shape and fail. Dropping is always safe in that order --
-- the earlier file recreates its own function, and this one drops it again.

drop function if exists public.card_payment_match_candidates(uuid, integer);
drop function if exists public.card_payment_settlement_candidates(uuid, integer);
drop function if exists public.card_payment_match_offers(uuid[], integer);

-- Every word that identifies exactly one of a company's accounts.
--
-- Words shorter than four characters are dropped (so "ONE" in Capital One
-- never matches), as are words that are generic in banking: those appear in
-- unrelated descriptions constantly and in account names often, and a word
-- that is in both is a coin flip, not evidence.
create or replace function public.card_payment_source_names(p_company uuid)
returns table (source_id uuid, token text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpsn$
  with src as (
    select s.id, s.display_name, s.credit_vendor_name, s.credit_qbo_account_name,
           pa.name as plaid_name, pa.official_name, pa.mask, pc.institution_name
    from public.card_sources s
    left join public.plaid_accounts pa on pa.source_id = s.id
    left join public.plaid_connections pc on pc.id = pa.connection_id
    where s.company_entity_id = p_company
  ), words as (
    select distinct src.id as source_id, upper(w.word) as token
    from src
    cross join lateral (values (src.display_name), (src.credit_vendor_name), (src.credit_qbo_account_name),
                               (src.plaid_name), (src.official_name), (src.institution_name), (src.mask)) v(name)
    cross join lateral regexp_split_to_table(coalesce(v.name, ''), '[^A-Za-z0-9]+') w(word)
    where length(w.word) >= 4
  ), kept as (
    select * from words
    where token not in (
      'BANK','BANKS','BANKING','CARD','CARDS','CREDIT','DEBIT','CHECK','CHECKING','SAVINGS',
      'ACCOUNT','ACCOUNTS','ACCT','PAYABLE','PAYABLES','PAYMENT','PAYMENTS','PAYMT','PYMT',
      'BUSINESS','COMMERCIAL','CORPORATE','COMPANY','HOLDINGS','GROUP','ENTERPRISES',
      'LIMITED','MASTERCARD','VISA','EXPRESS','REWARDS','ONLINE','AUTOPAY','AUTO',
      'TRANSFER','TRANSFERS','DEPOSIT','WITHDRAWAL','OPERATING','GENERAL','MAIN','PRIMARY',
      'FUND','FUNDS','MONEY','BILL','BILLS','STATEMENT','MONTHLY','DAILY','MISC','OTHER'
    )
  )
  select k.source_id, k.token
  from kept k
  where (select count(distinct k2.source_id) from kept k2 where k2.token = k.token) = 1;
$cpsn$;

-- What a bank description says about one account of the company.
--
--   'named'        the description names this very account
--   'other_source' it names a DIFFERENT account of the company
--   'unknown'      it names none of them
--
-- The PAYER's own account is never a contradiction: a bank line naturally
-- carries the name of the bank it is on. And 'named' wins over 'other_source',
-- because a line that names both accounts has still named this one.
--
-- The rule is written out in each picker rather than put in a function of its
-- own, and the reason is cost: the company's word list has to be built ONCE
-- per query (the `names` CTE), not once per candidate row. A helper taking a
-- description would rebuild it every time, which at a screen of rows times
-- twenty-five candidates each is thousands of rebuilds for one page.

-- From the paydown: the payments that could have made it, best evidence first.
create or replace function public.card_payment_match_options(p_transaction_id uuid, p_days integer default 7)
returns table (transaction_id uuid, txn_date date, amount numeric, description text,
  source_name text, batch_status text, qbo_account_name text, accounting_treatment text,
  day_gap integer, name_signal text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpmo$
  with card as (
    select t.id, t.company_entity_id, t.amount, t.txn_date, b.source_id
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    where t.id = p_transaction_id and coalesce(t.amount, 0) < 0 and t.txn_date is not null
  ), names as (
    select n.source_id, n.token
    from card c, public.card_payment_source_names(c.company_entity_id) n
  ), cand as (
    select t.id, t.txn_date, t.amount, t.description, s.display_name, b.status,
           t.qbo_account_name, t.accounting_treatment, abs(t.txn_date - c.txn_date)::integer as day_gap,
           c.source_id as paydown_source, s.id as payer_source
    from card c
    join public.card_transactions t on t.company_entity_id = c.company_entity_id and t.id <> c.id
    join public.card_import_batches b on b.id = t.batch_id and b.status <> 'voided'
    join public.card_sources s on s.id = b.source_id and s.id <> c.source_id
      and s.credit_qbo_account_type = 'Bank'
    where round(t.amount, 2) = round(-c.amount, 2)
      and t.txn_date between c.txn_date - greatest(coalesce(p_days, 7), 0)
                         and c.txn_date + greatest(coalesce(p_days, 7), 0)
      and t.status <> 'excluded'
      and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)
  ), scored as (
    select cand.*, coalesce((
      select case when bool_or(n.source_id = cand.paydown_source) then 'named'
                  when bool_or(n.source_id is distinct from cand.payer_source) then 'other_source'
             end
      from (select distinct upper(w.word) as token
            from regexp_split_to_table(coalesce(cand.description, ''), '[^A-Za-z0-9]+') w(word)
            where length(w.word) >= 4) said
      join names n on n.token = said.token), 'unknown') as name_signal
    from cand
  )
  select scored.id, scored.txn_date, scored.amount, scored.description, scored.display_name,
         scored.status, scored.qbo_account_name, scored.accounting_treatment, scored.day_gap,
         scored.name_signal
  from scored
  order by case scored.name_signal when 'named' then 0 when 'unknown' then 1 else 2 end,
           scored.day_gap, scored.txn_date desc
  limit 25;
$cpmo$;

-- From the payment: the paydowns it could have settled.
--
-- Only an import that can still be edited, because this is the row the confirm
-- has to change. From the other direction the opposite holds and is deliberate:
-- the paying row is read, never written, so its import may be anything.
create or replace function public.card_payment_settlement_options(p_transaction_id uuid, p_days integer default 7)
returns table (transaction_id uuid, txn_date date, amount numeric, description text,
  source_name text, batch_status text, qbo_account_name text, accounting_treatment text,
  day_gap integer, name_signal text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpso$
  with payer as (
    select t.id, t.company_entity_id, t.amount, t.txn_date, t.description, b.source_id
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    join public.card_sources s on s.id = b.source_id and s.credit_qbo_account_type = 'Bank'
    where t.id = p_transaction_id and coalesce(t.amount, 0) > 0 and t.txn_date is not null
      and t.status <> 'excluded'
      and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)
  ), names as (
    select n.source_id, n.token
    from payer p, public.card_payment_source_names(p.company_entity_id) n
  ), said as (
    -- One description this time -- the payment's own -- read against each
    -- paydown's account.
    select distinct upper(w.word) as token
    from payer p
    cross join lateral regexp_split_to_table(coalesce(p.description, ''), '[^A-Za-z0-9]+') w(word)
    where length(w.word) >= 4
  ), cand as (
    select t.id, t.txn_date, t.amount, t.description, s.display_name, b.status,
           t.qbo_account_name, t.accounting_treatment, abs(t.txn_date - p.txn_date)::integer as day_gap,
           s.id as paydown_source, p.source_id as payer_source
    from payer p
    join public.card_transactions t on t.company_entity_id = p.company_entity_id and t.id <> p.id
    join public.card_import_batches b on b.id = t.batch_id and b.status in ('draft', 'categorized')
    join public.card_sources s on s.id = b.source_id and s.id <> p.source_id
      and coalesce(s.credit_qbo_account_type, '') <> 'Bank'
    where round(t.amount, 2) = round(-p.amount, 2)
      and t.txn_date between p.txn_date - greatest(coalesce(p_days, 7), 0)
                         and p.txn_date + greatest(coalesce(p_days, 7), 0)
      and not exists (select 1 from public.card_payment_matches m where m.card_transaction_id = t.id)
  ), scored as (
    select cand.*, coalesce((
      select case when bool_or(n.source_id = cand.paydown_source) then 'named'
                  when bool_or(n.source_id is distinct from cand.payer_source) then 'other_source'
             end
      from said join names n on n.token = said.token), 'unknown') as name_signal
    from cand
  )
  select scored.id, scored.txn_date, scored.amount, scored.description, scored.display_name,
         scored.status, scored.qbo_account_name, scored.accounting_treatment, scored.day_gap,
         scored.name_signal
  from scored
  order by case scored.name_signal when 'named' then 0 when 'unknown' then 1 else 2 end,
           scored.day_gap, scored.txn_date desc
  limit 25;
$cpso$;

-- One answer for a whole screen, whichever side the screen is.
--
-- `side` says which row was asked about ('paydown' = the row that leaves the
-- entry, 'payment' = the row that posts) and the other_* columns describe its
-- counterpart, which are filled only where there is exactly one answer to give.
-- `contested` says why there is none: not that the row has several candidates,
-- but that its single candidate is also somebody else's single candidate.
create or replace function public.card_payment_offers(p_transaction_ids uuid[], p_days integer default 7)
returns table (transaction_id uuid, side text, candidate_count integer, contested boolean,
  name_signal text, other_transaction_id uuid, other_txn_date date, other_amount numeric,
  other_source_name text, other_batch_status text, other_description text)
language sql stable security invoker set search_path = 'public', 'pg_temp' as $cpo$
  with scope as (
    select t.id, case when coalesce(s.credit_qbo_account_type, '') = 'Bank' then 'payment' else 'paydown' end as side
    from public.card_transactions t
    join public.card_import_batches b on b.id = t.batch_id
    join public.card_sources s on s.id = b.source_id
    where t.id = any(coalesce(p_transaction_ids, '{}'::uuid[]))
      and ((coalesce(s.credit_qbo_account_type, '') <> 'Bank' and coalesce(t.amount, 0) < 0
            and not exists (select 1 from public.card_payment_matches m where m.card_transaction_id = t.id))
        or (coalesce(s.credit_qbo_account_type, '') = 'Bank' and coalesce(t.amount, 0) > 0
            and t.status <> 'excluded'
            and not exists (select 1 from public.card_payment_matches m where m.bank_transaction_id = t.id)))
    limit 400
  ), found as (
    select sc.id, sc.side, c.*, count(*) over (partition by sc.id) as n,
           row_number() over (partition by sc.id order by c.day_gap, c.txn_date desc) as rn
    from scope sc
    cross join lateral (
      select * from public.card_payment_match_options(sc.id, p_days) where sc.side = 'paydown'
      union all
      select * from public.card_payment_settlement_options(sc.id, p_days) where sc.side = 'payment'
    ) c
    -- An account the description names as somebody ELSE'S is not an offer. It
    -- stays in the picker, where a person can see the words and judge.
    where c.name_signal <> 'other_source'
  ), best as (
    select * from found where rn = 1
  ), claims as (
    -- One payment cannot be the single answer for two rows at once.
    select b.transaction_id as other_id, count(*) as askers
    from best b where b.n = 1 group by b.transaction_id
  )
  select f.id, f.side, f.n::integer, coalesce(cl.askers, 1) > 1, f.name_signal,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.transaction_id end,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.txn_date end,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.amount end,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.source_name end,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.batch_status end,
         case when f.n = 1 and coalesce(cl.askers, 1) = 1 then f.description end
  from best f
  left join claims cl on cl.other_id = f.transaction_id and f.n = 1;
$cpo$;

revoke all on function public.card_payment_source_names(uuid) from public, anon;
revoke all on function public.card_payment_match_options(uuid, integer) from public, anon;
revoke all on function public.card_payment_settlement_options(uuid, integer) from public, anon;
revoke all on function public.card_payment_offers(uuid[], integer) from public, anon;
grant execute on function public.card_payment_source_names(uuid) to authenticated;
grant execute on function public.card_payment_match_options(uuid, integer) to authenticated;
grant execute on function public.card_payment_settlement_options(uuid, integer) to authenticated;
grant execute on function public.card_payment_offers(uuid[], integer) to authenticated;
