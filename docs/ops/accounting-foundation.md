# QBO-seeded accounting foundation

## Purpose and ownership

First milestone toward Silo-owned books, reached through Accounting → Books & setup. QBO seeds account identities and the opening trial balance. Silo retains independent UUIDs, QBO account/connection mappings, the account source snapshot, and a reviewed opening snapshot. There is one company baseline. It is not an outbound journal and cannot be opened in the journal composer.

**QBO remains the official ledger.** This milestone is onboarding and a source register, not a complete independent general ledger. No automatic roll-forward, accounting-authority switch, historical transaction import, open AR/AP import, reconciliation, new period locks or reversal controls are implemented here. Those are required follow-up work before offering independent Silo books. Existing journal approval/reopen/void and QBO recovery remain unchanged.

## Read-only preflight and assumptions

Checked current main after #674; no accounting settings, fiscal-year settings, Silo COA or opening-balance schema existed. Production table columns, QBO constraints and report/adjustment RLS were inspected. Existing QBO TrialBalance metadata confirmed Account/Debit/Credit columns, Header currency/basis/end period, a nested Section with Data rows and a top-level TOTAL. No report was fetched or financial record changed during preflight.

QBO report runs are service-written. The seed RPC accepts a stored report ID and fiscal month, not browser-supplied accounts or amounts. Finance-safe connection discovery returns names/realm/environment/account-sync time only, never tokens. The existing report function accepts an explicit connection ID scoped to the caller's active company; onboarding always supplies it. Legacy report callers retain default selection.

## Workflow

1. Connect QBO using existing administration and sync its chart of accounts. The foundation reads this company/connection-scoped mirror; it does not invoke an admin-only account-sync operation as a finance user.
2. In Books & setup, select the QBO company, balances-as-of date, accounting basis and confirm the fiscal-year start month. Fetch a read-only TrialBalance, or select one of the latest 100 stored successful reports for that connection.
3. The seed transaction validates provenance, header/date/currency/basis, unfiltered Debit/Credit shape, identified unique accounts, nonnegative exact decimal amounts, balance and provider TOTAL. It seeds stable account IDs and prepares opening history atomically. Missing reference accounts, unsupported shapes and filtered reports fail without partial settings/accounts/balances.
4. Review the saved line-by-line trial balance and totals. The accounting start date is the next day. Review AR/AP controls and midyear income/equity with the accountant: a trial balance alone does not migrate open invoices, bills or historical detail.
5. Accept through the existing finance-dialog pattern with a checkbox and review note. Server-generated identity/time and the expected snapshot hash bind the decision to the reviewed content. Accepted history is immutable; repeat acceptance is idempotent. Draft re-seeding retains Silo account identities.
6. Use Journal register to open existing adjustment entries through SiloJE; transaction batches return to Transactions. The paginated source register distinguishes parent review status and QBO delivery state. It is not a calculated GL or a combined trial balance.

The seed does not change Plaid/CSV authority dates, feed mappings, posting enablement or existing postings. A migration cutover and a feed cutover are different decisions: establish non-overlapping source ownership before posting live bank transactions. Do not add opening history to a QBO report that already includes those balances.

## Controls and failure handling

- New table writes are RPC-only; finance/exec read access is active-company scoped. No anonymous grants. Service-only existing RPC grants are unchanged.
- Parent company row locking serializes seed/re-seed/accept, including first setup. Errors roll back the entire seed. Identical retry retains identities; refreshed report changes the reviewed hash.
- Accepted baseline cannot be re-seeded. Correction policy and independent ledger reversals are deferred rather than silently editing accepted history.
- All three new tables use the existing append-only finance audit trigger. QBO report provenance and opening snapshot persist independently of subsequent QBO account refreshes.
- Books authority is fixed to QBO in this milestone. There is no cosmetic independent-mode switch or unenforced period-lock setting.

## Verification and rollout

Local PGlite executes the real dependency migrations and foundation migration twice under Supabase-style default grants. New tests exercise atomic failure, tenant/permission isolation, unsupported/filtered/partial reports, stable identities, stale approval, immutable/idempotent acceptance, audit and zero outbound journals. UI tests execute the actual form→report→seed→review→accept path. Report-handler tests execute real connection selection and verify no foreign/inactive connection reaches QBO. Stale-hash and wrong-connection mutations each cause their test to fail.

The existing Plaid database harness now applies the foundation migration before executing the verifier tail, so it checks both Plaid and foundation blocks instead of testing new schema against an old fixture. The remaining full production verifier requires the production schema; no new migration has been applied there by this PR.

After review and merge, separately authorize/apply `20260912231606_accounting_foundation.sql` and deploy `quickbooks-report`, then run schema and function drift checks. Test QBO seeding in Test Company first. Production remains unchanged in this draft. No Plaid environment switch, migration application, function deployment or journal posting was performed.

Visual browser review at desktop/phone widths in both themes and a real sandbox TrialBalance fetch remain draft acceptance gates. Local browser preview was not available in this session; synthetic UI execution is not a screenshot review.
