# Plaid bank and card feeds — V1

Plaid adds an ingestion source to **Card Coding**. Each mapped account feeds `card_transactions` and monthly `card_import_batches`. Users code, review and approve there; `quickbooks-post-journal` remains the only journal writer. Nothing syncs to Clarity.

## Included and deliberately bounded

- US depository and credit card accounts, USD accounting only. Foreign or unknown transaction currencies remain excluded.
- Plaid Link, OAuth return to the same Card Coding page, repair and explicit resume, account balances and account mapping.
- Manual sync plus an optional six-hour polling schedule. Polling reads Plaid's available data; it does not purchase `/transactions/refresh` or force a bank refresh.
- One independent `/transactions/sync` cursor per account using `options.account_id`. A newly mapped account gets its own history. Initial history defaults to 90 days, configured at new Item creation; the bank may supply less.
- Stable provider IDs, complete pagination before one atomic cursor/ledger commit, leases, bounded retries, and append-only audit events.
- No automatic approval or posting. No matching engine, payroll calculation, QBO bank-feed import, or new approval application.

## Rollout order (separate from this draft PR)

1. Review and merge the draft through the normal process. Apply `20260912052930_plaid_bank_feed.sql` after the Finance V1 control migration. Run `verify_v2_schema.sql`. Historical approvals and posted entries remain intact.
2. Configure the **Silo** Edge Function secrets below. Start with Plaid Sandbox. The new function does not reuse Clarity credentials or connections.
3. Deploy `plaid-finance` and the updated `card-categorize` with the existing manual Deploy Edge Function workflow. Retain JWT verification. Publish the normal static frontend update.
4. In Card Coding → Bank feeds, connect a test institution, map one account, set the authority cutover date, and sync manually. Verify pending replacement, modified/removed rows, a repeated sync, and the coding/review flow. Keep new sources' posting disabled until mapping and balances are reviewed.
5. Configure production Plaid separately when ready. Connect real accounts only then. Select a cutover date after the last authoritative CSV period. Review the first batch before enabling posting on its source.
6. Enable scheduled ingestion only after manual sync passes: Edge secret `PLAID_BACKGROUND_SYNC_ENABLED=true` and GitHub repository variable `PLAID_SYNC_ENABLED=true`. Both default off. The workflow uses existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets, which never enter the browser.

| Edge secret | Value / purpose |
|---|---|
| `PLAID_ENVIRONMENT` | Explicit `sandbox` or `production`; mismatched stored Items are refused |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | Credentials for that Plaid environment |
| `PLAID_TOKEN_ENCRYPTION_KEY` | Base64-encoded 32 random bytes; protect and back up before connecting accounts |
| `PLAID_REDIRECT_URI` | Registered HTTPS URL of `v2/card-coding.html`, without query or fragment; required for OAuth |
| `PLAID_DAYS_REQUESTED` | Optional integer 1–730, default 90, chosen when the Item is created |
| `PLAID_BACKGROUND_SYNC_ENABLED` | Optional `true` after rollout; service-role ingestion only |

Access tokens are AES-GCM ciphertext in a service-only table, bound to company, Item and environment. Do not rotate the encryption key by simply replacing it: existing ciphertext must be re-encrypted using the old key in a separately reviewed operation, or connections must be re-established. Never put access tokens, encryption keys or service keys in page config, PRs, logs or workflow output.

## Account authority and coding

The authority boundary is company + QBO connection + balancing account, across **all** card sources. Mapping rejects a cutover that overlaps existing CSV transactions on that account; later CSV inserts are also blocked, including through a second source. One Plaid account cannot claim an already active account authority. This is a source cutover, not fuzzy transaction matching. Previously posted data and deleted/reconnected provider Items need deliberate operator review.

| Movement | Required review treatment |
|---|---|
| Card purchase / refund | Purchase/refund treatment and a reviewed counter-account; conservative purchase hints only |
| Bank deposit | Manual coding and explicit deposit/settlement treatment |
| Shopify payout | Shopify settlement to the clearing account; the existing Shopify output owns revenue and fees |
| Internal transfer | Transfer clearing for both observed legs; do not expense it or directly duplicate the opposite bank account |
| Card payment | The bank leg owns settlement to card liability/AP; exclude the duplicate payment leg in the card feed |
| Payroll withdrawal | Payroll settlement to clearing/liability; approved payroll output owns wage/tax expense |
| Prepaid / fixed asset purchase | Asset account; existing schedules own amortization/depreciation |

Bank rows start with `unknown` treatment and require explicit review before approval. Purchase AI accepts only eligible card purchase outflows. Plaid rules must be scoped to the exact source and direction; CSV global rules cannot silently code bank transactions. Treatment validation supplements human review; it cannot infer whether another system already accounted for a transaction.

## Changed transactions and recovery

- Pending and removed rows remain excluded. Pending-to-posted replacements use the provider's stable IDs and link, even across pages. A missing or malformed lifecycle field fails the sync rather than guessing that a row is posted.
- Before approval, provider changes update the ledger and invalidate affected coding for review; date changes move mutable rows into the correct monthly batch. A frozen row is preserved. Changes to accounting facts become exceptions; proven metadata-only changes and still-unpostable excluded rows are audited without artificial correcting journals. Open exceptions block new approval/posting claims while recovery of an existing exact QBO claim remains available.
- For an approved, unposted batch, reopen it explicitly, then resolve the exception and review again. For an already posted contribution, create and post the correction through the existing JE composer, then link that correction and a reason to the exception. Excluded frozen rows with no accounting effect do not need artificial correcting journals.
- A timeout before the atomic apply leaves the old cursor. A lost response after commit is safe to retry: stable IDs and cursor comparison prevent duplicate ingestion. Do not reset cursors or delete ledger rows as a recovery shortcut. A cycle is bounded to 20,000 changes and 50 pages; an oversized cycle requires operator review of the import limit/history plan and does not advance its cursor.
- A sync lease lasts five minutes. A crashed worker may need that interval before retry; an old worker cannot release a newer lease. The scheduler reports partial account failures as failures.
- A successful token exchange is saved before fetching accounts. If account metadata fails, use **Refresh accounts**. Initial registration is retried while the token is available. Only two definitive database rejections plus a confirmed absent record permit revoking that new Item; an empty read after a transport failure does not prove the registration rolled back. Ambiguous persistence or cleanup is reported explicitly. Inspect the connection in Plaid and Silo before starting another Link session.
- **Stop syncing** pauses Silo ingestion; it does not revoke Plaid consent or remove the Item. Resume uses Link repair. To revoke access, use Plaid/institution controls and then stop syncing in Silo. Pausing does not release the account's historical authority or permit overlapping CSV imports.

## Validation evidence

The PR runs real PostgreSQL migration/RLS/RPC tests with PGlite, actual Edge handler execution with synthetic HTTP/database IO, real page callback tests, and sync protocol/crypto/scheduler tests. No financial credentials are required. These verify failure handling and database invariants; they do not claim a live Plaid institution/OAuth connection was exercised. Live Sandbox and first production account checks belong to rollout above.

Primary API contracts: [Link](https://plaid.com/docs/api/link/), [OAuth](https://plaid.com/docs/link/oauth/), [update mode](https://plaid.com/docs/link/update-mode/), [Transactions Sync](https://plaid.com/docs/api/products/transactions/), [transaction lifecycle](https://plaid.com/docs/transactions/transactions-data/).
