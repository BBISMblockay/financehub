-- Card name, cardholder, and the issuer's own cleaned merchant.
--
-- From a real Divvy export. Three things it carries that the first cut threw
-- away, all of them load-bearing:
--
-- 1. "Card Name" is NOT the card brand -- it is the Divvy virtual card, and
--    Baseballism uses it as a cost centre: 'Software', 'Supplies - HQ',
--    'Lease & Rent', 'Left Field Real Estate', 'COLAB'. For some merchants it
--    is a far better predictor of the account than the merchant is. Bill.com
--    is the clearest case: as a merchant it means nothing (it is a payment
--    processor and could be any expense on earth), but 'BILL.COM* WASHINGTON P'
--    on the 'Lease & Rent' card is unmistakably rent -- and two of those rows
--    are $102,900 and $205,800.
--
-- 2. Card Name is often blank, and where it is, the person is the identity --
--    first/last name, or the cardholder email that Divvy also exports.
--
-- 3. "Clean Merchant Name" is the issuer's own normalisation ('APPLE.COM/BILL'
--    -> 'Apple', 'SPI*DIRECTV SERVICE' -> 'DIRECTV'). It is better than ours
--    because the issuer knows the merchant id behind the descriptor, and we
--    are only reading the string.

alter table public.card_transactions
  add column if not exists card_name text,
  add column if not exists cardholder_email text,
  -- The issuer's cleaned merchant, when the export has one. Kept separate from
  -- `merchant` so it is always visible which one a rule matched on.
  add column if not exists clean_merchant text;

create index if not exists idx_card_txn_card_name
  on public.card_transactions (company_entity_id, card_name)
  where card_name is not null;

-- A rule can now key on the card name instead of the merchant. This is what
-- makes an internal card usable as a coding dimension: one rule saying the
-- 'Lease & Rent' card codes to Rent Expense settles every row on it, whatever
-- processor happens to appear as the merchant.
alter table public.card_coding_rules
  add column if not exists match_field text not null default 'merchant';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.card_coding_rules'::regclass
       and conname = 'card_coding_rules_match_field_check'
  ) then
    alter table public.card_coding_rules
      add constraint card_coding_rules_match_field_check
      check (match_field in ('merchant', 'card_name'));
  end if;
end $$;

-- The unique key has to include the field, or a card-name rule and a merchant
-- rule sharing a string collide.
alter table public.card_coding_rules
  drop constraint if exists card_coding_rules_company_entity_id_source_id_match_type_pat_key;

create unique index if not exists uq_card_rules_pattern
  on public.card_coding_rules
     (company_entity_id, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
      match_field, match_type, pattern);

drop view if exists public.card_transactions_v;
create view public.card_transactions_v
with (security_invoker = true) as
select
  t.*,
  b.status        as batch_status,
  b.label         as batch_label,
  b.entry_date    as batch_entry_date,
  s.display_name  as source_name,
  s.source_key    as source_key,
  -- The key a merchant rule matches on. The issuer's cleaned name wins where
  -- there is one: it collapses 'AMAZON MARK* 5O4IE9RI2' and
  -- 'AMAZON MARK* 5Q1MF0FI0' to the same thing without us guessing at the
  -- shape of the reference code. The cost is that a rule learned on Divvy
  -- ('amazon') does not match an Amex row ('amzn mktp us') -- both keys are
  -- correct for their own feed, and each accumulates its own rule.
  public.normalize_merchant(coalesce(t.clean_merchant, t.description)) as merchant_norm
from public.card_transactions t
join public.card_import_batches b on b.id = t.batch_id
join public.card_sources s on s.id = b.source_id;

grant select on public.card_transactions_v to authenticated;
