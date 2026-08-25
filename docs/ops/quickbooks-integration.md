# QuickBooks Online integration

Status: **phase 1–2 (read-only).** SILO can connect a QBO company and mirror
its chart of accounts. Nothing writes to the general ledger yet.

## What this is for

The scope decision (2026-08-26) is deliberate and narrow:

- **QBO owns the ledger.** Close, reconcile, file, report. SILO does not
  replicate double-entry, period locking, bank reconciliation, inventory
  valuation, fixed assets, or payroll tax filing, and is not intended to.
- **SILO owns operations** — POs, landed cost, inventory, channel revenue,
  AP intake and approval — and produces journal entries a human reviews.

Phase 3 (posting journal entries) and phase 4 (pulling QBO reports into SILO)
build on this, but a human approving each post is a requirement of the design,
not a temporary limitation.

## Setup

1. **Intuit app.** developer.intuit.com → workspace *Silo* → app *Silo*.
   Scope `com.intuit.quickbooks.accounting`. Redirect URI (Settings →
   Redirect URIs, per environment):

   ```
   https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/quickbooks-oauth-callback
   ```

   The App URLs tab (host domain / launch / disconnect) is for a Marketplace
   listing and can be left blank.

2. **Edge-function secrets** (Supabase → *Silo* → Edge Functions → Secrets):

   | Secret | Value |
   |---|---|
   | `QBO_CLIENT_ID` | Intuit app client id |
   | `QBO_CLIENT_SECRET` | Intuit app client secret |

   Development and production keys are different pairs. The per-connection
   `environment` column picks the API host; the secrets must match it.

3. **Deploy the edge functions** — merging a PR does *not* deploy them:

   ```
   supabase functions deploy quickbooks-oauth-start
   supabase functions deploy quickbooks-oauth-callback --no-verify-jwt
   supabase functions deploy quickbooks-accounts-sync
   ```

   `quickbooks-oauth-callback` **must** be deployed with `--no-verify-jwt`:
   Intuit redirects a browser to it with no Supabase session. The single-use
   nonce in `state` is what authenticates that round trip.

4. **Connect** at `/v2/integrations.html` → QuickBooks Online. Start with the
   sandbox company. Then **Pull accounts**, and map them on
   `/v2/accounting-export.html`.

## Tables

| Table | Purpose |
|---|---|
| `quickbooks_connections` | One row per connected QBO company. Carries live OAuth tokens, so SELECT is `is_admin_user()`-gated to match the write policy — same stance as `ad_platform_connections`. Unique on `(company_entity_id, realm_id)` so reconnecting updates rather than duplicating |
| `quickbooks_oauth_states` | Single-use 10-minute CSRF nonces. RLS on, no policies — service-role only |
| `quickbooks_accounts` | Mirror of the QBO chart of accounts, refreshed by `quickbooks-accounts-sync`. No credentials, so readable by any active company member (the mapping UI is not admin-only) |
| `accounting_coa_map` | Gains `qbo_account_id` / `qbo_account_name`. `account_name` stays the CSV export's authority and the fallback with no connection |

## Token handling — the thing most likely to break

QBO tokens do **not** behave like Shopify's:

- Access token: **1 hour**.
- Refresh token: **~100 days**, and it **rotates on every refresh**.

`ensureAccessToken()` in `quickbooks-accounts-sync` refreshes 60s before
expiry and persists the rotated refresh token in the same update. If that
persist ever fails it throws rather than continuing — presenting a retired
refresh token on the next run would brick the connection until someone
reconnects by hand.

When the refresh window does lapse, the Integrations row shows
**"Authorization expired — reconnect"** rather than a generic error, because
no amount of retrying fixes it.

## Known limitation: per-location accounts

`revenue_template` and `refunds_template` expand `{location}` into a different
account per sales location, so a single QBO account cannot represent them.
They stay free-text and will be matched to QBO **by name** at post time.
Every other map key binds to a real QBO account id.

If phase 3 shows name-matching to be too fragile, the fix is a per-location
mapping table rather than widening these two keys.

## Chart-of-accounts naming

The migration promotes the stored `accounting_coa_map` names to the set the
Accounting Export page was already emitting in the browser. Before this
change the page rewrote stale names in memory on every load, so the stored
rows and the exported CSV disagreed and "Apply recommended names" appeared to
do nothing. The substantive corrections:

- Sales discounts → contra-revenue, not `COGS - Sales Discounts`
- Sales tax → `Sales Tax Clearing`, not `COGS - Sales Tax Liability`
- Shopify deposits → `Shopify Clearing`, not generic `Accounts Receivable`
- Processing fees → `Shopify Processing Fees`, not `COGS - Processing Fees`

Nothing had been filed from these exports, so the values were corrected in
place rather than versioned.
