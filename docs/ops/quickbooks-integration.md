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

### Scope boundary (agreed 2026-08-26)

**In scope:** SILO builds the journal entry from Shopify sales and payouts,
maps each line to a QBO account and location, a human reviews it, SILO posts it
as a `JournalEntry`, logs the returned QBO document number, and blocks
double-posting.

**Out of scope, permanently:** the bank feed / "For Review" queue, categorizing
bank transactions, reconciliation, AP bill entry, invoicing, payroll. Those stay
in QuickBooks.

The bank feed is not merely descoped — **the QBO Accounting API does not expose
it.** There is no public endpoint to read the For Review queue, categorize its
items, or accept matches; Intuit gates bank-feed data behind separate partner
programs. What SILO *can* do is push a transaction that QBO's own matching
engine then offers against the downloaded bank line, so the accountant clicks
Match instead of categorizing from scratch. Do not re-open this as a feature
request without new information from Intuit.

## Setup

1. **Intuit app.** developer.intuit.com → workspace *Silo* → app *Silo*.
   Scope `com.intuit.quickbooks.accounting`. Redirect URI (Settings →
   Redirect URIs):

   ```
   https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/quickbooks-oauth-callback
   ```

   That page has **separate Development and Production sections** — the same
   URL must be added under each environment you intend to connect. Saving it
   under Development only is why a production connect attempt fails with a
   redirect-URI mismatch.

   The App URLs tab (host domain / launch / disconnect) is for a Marketplace
   listing and can be left blank.

2. **Edge-function secrets** (Supabase → *Silo* project → Edge Functions →
   Secrets). **One key pair**, plus one word saying which Intuit environment
   that pair belongs to:

   | Secret | Value |
   |---|---|
   | `QBO_CLIENT_ID` | Intuit app client id |
   | `QBO_CLIENT_SECRET` | Intuit app client secret |
   | `QBO_ENVIRONMENT` | `sandbox` or `production` (defaults to `sandbox` if unset) |

   A client id does not say which environment it belongs to, which is why
   `QBO_ENVIRONMENT` has to be declared. **Moving to production = overwrite the
   two secrets, flip that one word.** There is deliberately no second key pair
   to maintain.

   Getting production keys from Intuit may require filling in basic app details
   first (name, description, EULA and privacy-policy URLs). That is Intuit's
   gate, not SILO's.

   ### Switching environments

   The connection's `environment` column picks the API host independently of
   the keys, so a stale connection from the other environment would send the
   wrong keys at the wrong host and fail as an opaque token error. All three
   functions refuse that mismatch by name instead:

   - `quickbooks-oauth-start` only ever starts a handshake for the configured
     environment — the browser does not choose, and there is one Connect button
     rather than two.
   - `quickbooks-oauth-callback` refuses if the keys were flipped mid-handshake.
   - `quickbooks-accounts-sync` returns `409 environment_mismatch` naming both
     sides, before making any API call.

   So the switch is: **disconnect the old company, swap the secrets, flip
   `QBO_ENVIRONMENT`, reconnect.** Forgetting the disconnect is not dangerous —
   it just gets refused with an explanation.

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
| `quickbooks_locations` | Mirror of QBO locations (its `Department` entity), same read policy as `quickbooks_accounts` |
| `accounting_location_map` | `sales_by_day.location_tag` → QBO location id. Writable by any active company member, same as the COA mapping |

## Token handling — the thing most likely to break

QBO tokens do **not** behave like Shopify's:

- Access token: **1 hour**.
- Refresh token: **~100 days**, and it **rotates on every refresh**.

`ensureAccessToken()` in `quickbooks-accounts-sync` refreshes 60s before
expiry and persists the rotated refresh token in the same update. If that
persist ever fails it throws rather than continuing — presenting a retired
refresh token on the next run would brick the connection until someone
reconnects by hand.

Endpoints are read from Intuit's discovery document
(`/.well-known/openid_configuration`, or `openid_sandbox_configuration` for
sandbox) rather than hardcoded, cached per isolate, with the currently published
values as fallback. A discovery outage therefore degrades to the old hardcoded
behaviour instead of breaking the integration.

Every stored API error carries Intuit's `intuit_tid` response header where one
is present. That trace id is what lets Intuit support locate the exact request
— worth far more than a reproduction attempt when something fails at month end.

When the refresh window does lapse, the Integrations row shows
**"Authorization expired — reconnect"** rather than a generic error, because
no amount of retrying fixes it.

## Locations

QuickBooks calls this dimension **Location** in its UI and **`Department`** in
its API (the UI label is even renameable — Location / Division / Store /
Territory). Everything in SILO is named `location`, matching what a human sees
in QuickBooks; only the API calls in `quickbooks-accounts-sync` say
`Department`. This is *not* QBO `Class`, a separate dimension SILO does not
use.

A journal line carries its location as a **tag**, not as a separate account.
Baseballism runs 28 active locations — per-location accounts would mean 56
accounts for revenue and refunds alone, which is why
`accounting_coa_map.revenue_template` / `refunds_template` still carry a
`{location}` placeholder. Location tagging replaces that: one account id, plus
a location reference per line.

Requires **location tracking enabled** in QuickBooks (Settings → Advanced →
Categories → Track locations), which is a **Plus or Advanced** feature. The
sync reads that preference into
`quickbooks_connections.location_tracking_enabled`, so an empty location list
can say *why* it is empty rather than showing a blank dropdown.

### Why the mapping is keyed on `location_tag`

`accounting_location_map` maps `sales_by_day.location_tag` → QBO location id,
**not** `locations.location_code`.

Measured 2026-08-26 over 12 months of sales: 19 distinct `location_tag` values,
only **10** matching a `locations.location_code` exactly, and **3**
(`field_of_dreams`, `st_louis`, `mission_viejo`) not matching even
case-insensitively — `location_code` is inconsistently formatted, snake_case on
some rows and Title Case with spaces and periods on others.

Routing the mapping through `locations` would therefore drop real revenue
locations silently. `location_tag` is what `accounting_sales_buckets()` emits
and what the journal is built from, so it is the honest key.

**That formatting inconsistency in `locations.location_code` is a real latent
bug** for anything else joining those two tables. It is a separate cleanup and
does not block this work.

### Still open

The journal entry itself has not yet been reshaped to use locations — the CSV
export still emits per-location account names via the `{location}` templates.
Collapsing those two keys to a single account plus a location tag belongs with
phase 3, where the posted entry's shape is designed as a whole.

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
