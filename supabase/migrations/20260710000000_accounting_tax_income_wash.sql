-- Sales tax income wash: Accounting Export's journal entry already booked
-- the tax expense/payable pair (COGS-tagged debit vs. Sales Tax Payable
-- credit), matching the balance sheet + expense recognition. Per Blake's
-- real June export, their process also books a THIRD leg on top: a
-- per-location debit to the SAME revenue account (reducing recognized
-- revenue by the tax collected) offset by one combined credit across every
-- location ("Sales Tax Income All" in their sheet) — recognizing the
-- pass-through as income so the wash is visible on the P&L, not just the
-- balance sheet. Verified against their export: summed per-location tax
-- figures = $174,506.86 = exactly the combined line's amount.
--
-- Seeds the new tax_income_all COA map key with the same default-naming
-- convention as the rest of the mapping (which was already renamed away
-- from the literal legacy Shopify Journal Entry names to Baseballism's own
-- clean scheme — tax_liability is saved as "Sales Tax Expense", so this
-- pairs it with "Sales Tax Income").

insert into public.accounting_coa_map (company_entity_id, map_key, account_name)
values
  ('3bd934c9-4cdd-429b-9076-f8f6b45d4eb7', 'tax_income_all', 'Sales Tax Income')
on conflict (company_entity_id, map_key) do nothing;
