-- fixed_assets: allow negative cost, for landlord TI-reimbursement contra-assets.
--
-- Baseballism's AssetGuru register carries 9 landlord tenant-improvement
-- reimbursements as their own asset-shaped rows with NEGATIVE Purchase Price
-- (e.g. "Quimby TI Reimb", "ATL TI Reimb.") -- confirmed against Baseballism's
-- own negative-asset amortization schedule: each one runs its OWN standalone
-- straight-line schedule (same in_service_date / useful_life_months
-- convention as any other asset here), not netted against a specific
-- positive asset's cost. They post to the same Property Plant & Equipment /
-- Accumulated Depreciation / Depreciation Expense accounts as a real asset,
-- just amortizing the balance toward zero from below instead of above.
--
-- cost > 0 assumed every asset was a real capitalized cost. Widened to
-- cost <> 0 (a zero-cost row still makes no sense) and the salvage_value
-- check split accordingly -- salvage only means something against a
-- positive cost; a contra-asset amortizes fully to zero, so it must carry
-- salvage_value = 0.
--
-- fixed_asset_depreciation_v / fixed_asset_balances_v need no change: their
-- math is plain (cost - salvage) / months arithmetic with a final-period
-- plug to zero out rounding, which is sign-agnostic.

alter table public.fixed_assets drop constraint if exists fixed_assets_cost_check;
alter table public.fixed_assets add constraint fixed_assets_cost_check check (cost <> 0);

alter table public.fixed_assets drop constraint if exists fixed_assets_check;
alter table public.fixed_assets add constraint fixed_assets_check check (
  (cost > 0 and salvage_value >= 0 and salvage_value < cost)
  or (cost < 0 and salvage_value = 0)
);
