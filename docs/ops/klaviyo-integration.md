# Klaviyo integration (native)

SILO reads Klaviyo's own API directly, as a connection of its own, alongside
Shopify, the ad platforms and Redo. Read-only: it never sends, edits a flow or
imports a profile.

`klaviyo_performance_daily` (Klaviyo through **Windsor.ai**, `source =
'windsor'`) still exists and is untouched. The two never run for the same
company — see [Not double counting](#not-double-counting) below.

---

## The pieces

| Piece | Where |
|---|---|
| Connection (one row per company) | `klaviyo_connections` |
| Messages (campaign + flow messages) | `klaviyo_messages` |
| Window totals per message | `klaviyo_message_performance` → read `klaviyo_message_performance_v` |
| Flow numbers per day | `klaviyo_flow_daily` → read `klaviyo_flow_daily_v` |
| Sync | `scripts/klaviyo-sync.mjs` → `scripts/lib/klaviyo-sync-core.mjs` |
| Nightly | `.github/workflows/klaviyo-sync.yml` (11:00 UTC + 17:00 catch-up) |
| Job record | `sync_jobs`, `job_type = 'klaviyo'` |
| First sync | `integration_bootstrap_jobs`, `integration = 'klaviyo'`, one `performance` stage |
| Freshness | the `klaviyo` feed in `scripts/lib/integration-reconcile-core.mjs` |
| UI | the Klaviyo card on `/v2/integrations.html`, guide key `klaviyo` |
| Edge functions | `test-klaviyo-connection`, `klaviyo-oauth-start`, `klaviyo-oauth-callback` |
| Migration | `supabase/migrations/20261109040000_klaviyo_native_integration.sql` |
| Tests | `scripts/tests/klaviyo-sync.test.mjs` (17 mutations, in `sync-tests.yml`) |

## Connecting a company

1. In Klaviyo: **Settings → API keys → Create private API key**, access
   **Custom**, **Read** on `campaigns`, `flows`, `metrics`, `segments` and
   `lists`. Only Owner, Admin or Manager can create one, and **Klaviyo cannot
   change a key's scopes afterwards** — a key short of one has to be replaced.
2. In SILO: Integrations → Klaviyo → **Paste an API key…**. The key starts
   `pk_`. (The short six-character company ID is Klaviyo's *public* key and
   cannot read reports.)
3. SILO tests it immediately. The test reads back the account, its reporting
   timezone and the conversion metric.
4. Pick **what counts as a conversion** if the test could not (it chooses
   `Placed Order`, then `Ordered Product`, by exact name). Nothing can be
   fetched without one.
5. Switch **Sync** on. That is the consent, and it is what queues the first
   import — a year, in ≤365-day chunks, newest first.

**OAuth** instead of a key needs a registered Klaviyo app and the
`KLAVIYO_CLIENT_ID` / `KLAVIYO_CLIENT_SECRET` edge-function secrets. Until
those exist, **Connect with Klaviyo** says so and the key is the way in. Both
modes live on the same row, so switching needs no migration.

## What Klaviyo gives, and the three things to keep straight

1. **There is no campaign series endpoint.** `POST
   /api/campaign-values-reports/` returns window totals per campaign message;
   only flows (and forms and segments) have an `interval: daily` series. So
   campaign rows carry `timeframe_start` / `timeframe_end` and **are not
   daily**. `klaviyo_messages.send_time` is what a daily rollup attributes a
   campaign to. **Never sum rows from two overlapping windows** — that counts
   the same sends twice.
2. **`conversion_metric_id` is stamped on every row.** Conversions and
   attributed revenue are measured against it; opens, clicks and deliveries are
   not. Rows carrying different values are not comparable and must not be
   added.
3. **No rate is stored, and NULL is not zero.** Every Klaviyo rate is a count
   over a count (returned as a fraction 0.0–1.0): pool the counts over the
   window, then divide. `NULL` means Klaviyo reported nothing — SMS statistics
   are null before **2025-10-01** and on contracted plans.

`conversion_value` is revenue Klaviyo **attributes** to email/SMS. It overlaps
net sales and what Meta, Google and TikTok claim, and must never be added to
either. `text_message_spend` is SMS sending cost, not ad spend, and does not
belong in `marketing_kpis_daily`.

## Rate limits, which shape the design

| Call | Limit |
|---|---|
| `POST /api/campaign-values-reports/` | **1/s, 2/min, 225/day** — the tightest in Klaviyo's API |
| `GET /api/campaigns` | 10/s, 150/min |
| `GET /api/flows` | 3/s, 60/min |
| `POST /api/metric-aggregates` | 3/s, 60/min (not used — see below) |

One campaign request covers **every** campaign, via `group_by: [campaign_id,
campaign_message_id, send_channel]`. Do not add a per-campaign loop: 225 a day
is roughly one company's nightly. Calls to the tight endpoints are spaced by
`MIN_INTERVAL_MS` rather than discovered through 429s, and a 429 or 503 is
retried only after its `Retry-After` — Klaviyo states an immediate retry always
429s again.

**Metric Aggregates is deliberately not used** for campaign or flow
performance: Klaviyo's own docs say it "does not match the data reflected in
the Klaviyo UI", because it filters on event time while the UI uses send date.

## Reading the outcome

Everything is visible from the stored record alone:

| `sync_jobs.status` | Meaning |
|---|---|
| no row at all | the connection has no credential, or no conversion metric: never attempted |
| `skipped` + "lacks a scope" | 403. The key needs a wider scope, which means a **new** key |
| `skipped` + "rejected the credential" | 401/400. The key is wrong or revoked |
| `skipped` + "needs reconnecting" | OAuth `invalid_grant`: uninstalled, or 90 days unused. `klaviyo_connections.reauth_required_at` is set and the nightly stops asking |
| `error` | anything else. The run fails and the window is unwritten |
| `success` | `result.chunks[]` carries per-window counts |

A skip is one company's configuration, not an outage: it never fails the run
for the others.

## Backfill and dry run

```
# everything since a date, newest-first in <=365-day chunks
gh workflow run klaviyo-sync.yml -f start_date=2025-01-01 -f company_entity_id=<uuid>

# see what Klaviyo returns, writing nothing
gh workflow run klaviyo-sync.yml -f dry_run=true -f company_entity_id=<uuid>
```

Worth doing the dry run first on a newly connected account.

## Not double counting

`scripts/lib/windsor-sync-core.mjs` checks `NATIVE_CONNECTION_TABLES` per
company: a Klaviyo account whose company has an active `klaviyo_connections`
row with `sync_enabled` is recorded `superseded_by_native` and **nothing is
fetched or written**, leaving its history cursor and last outcome alone, as a
paused account does. Windsor stays generic for every other source — this is a
map entry, not a per-source contract. Nothing joins or unions the two tables.

## Writes, and what a failure cannot do

Each window fetches **everything** first, then writes messages, then
performance, then retires what it did not return. A failure anywhere in the
fetch throws before the first write, so a partial fetch can never sweep away
rows it never reached. The sweep only touches rows older than this run's
timestamp (an overlapping newer run is safe), and the performance sweep is
scoped to the exact timeframe it asked for, because another window's totals are
a different measurement rather than a stale one.

## Pagination, per endpoint — do not generalise

The first live test failed on this, so it is written down rather than
inferred:

| Endpoint | `page[size]` | Max | Cursor |
|---|---|---|---|
| `GET /api/metrics` | **NOT accepted** | 200/page, fixed | `page[cursor]` |
| `GET /api/campaigns` | yes | 100 | `page[cursor]` |
| `GET /api/flows` | yes | 50 | `page[cursor]` |
| `GET /api/flows/{id}/flow-actions` | yes | 50 | `page[cursor]` |

Sending `page[size]` to `/api/metrics` returns **400** with
`'page_size' is not a valid field for the resource 'metric'` — which is a
SILO bug, not a bad key, and the connection test says so in those words
rather than telling an admin to replace a working credential.

## Reports

Three system reports, built from the Redo Email & SMS pair's definitions so the
columns and the rate rules read the same (`20261109210000`):

| Report | Grain | Notes |
|---|---|---|
| Email & SMS Performance (Klaviyo) | one row per message | the WIDEST stored window whose end is in the period, bounds shown |
| Email & SMS Revenue Trend (Klaviyo flows) | day | flows only -- there is no campaign series endpoint |
| Email vs SMS (Klaviyo) | channel | the same one-window pick, so it agrees with Performance |

**Per vendor, never merged with Redo's.** Redo credits revenue by its own rules;
Klaviyo attributes against the account's conversion metric. A combined report
would sum two vendors' attribution for a company running both and double count
the same orders.

**Why Performance picks one window instead of summing.** A campaign exists only
as a total over a measurement window, and SILO stores several for the same
campaign (the nightly's trailing 60 days, a backfill's year). Adding them double
counts the same sends, so the report shows one measurement and names its bounds.
A tie-out asserts one row per message and channel, which is what catches a
regression back to summing.

## The attribution page

`/v2/silo-attribution.html` does NOT use Klaviyo's numbers. It classifies visits
from Shopify journeys by their UTMs, so Klaviyo sends land there through
`utm_source=klaviyo` -- as their own channels since 2026-11-09, and before that
in the generic "Email -- Other" / "SMS -- Other" buckets.

**The two pages will not agree, and both are right.** Klaviyo credits an order to
a send by its conversion metric and lookback; SILO credits it to the last touch
it observed. Never add them.

**Klaviyo is not in the spend strip**, and cannot be until the account's currency
is stored: `redo_marketing_daily` carries `spend_currency` per row and
`klaviyo_flow_daily` carries none, so counting it would mean assuming dollars.
Klaviyo's account endpoint returns the currency and the sync already reads that
response for the timezone, so the fix is a column plus a sync change. Also note
Klaviyo reports SMS sending cost by day for FLOWS only, and charges for email by
plan rather than per send, so a Klaviyo Email spend row would never exist.

## The first sync, and how deep it goes

Three doors, all of them the same core:

1. **Turning sync on** queues a bootstrap job (365 days) AND kicks
   `integration-sync-kick`, which pulls a trailing 7 days straight away so the
   card is not empty while the queue is drained. The kick is best effort; the
   queued job is what guarantees the data.
2. **Workflow dispatch** with `start_date` for a dated backfill, cut into
   365-day chunks, newest first.
3. **The nightly**, a trailing 60 days (`days_back` on the connection row).

**Two different caps.** A campaign or flow VALUES report takes a year at a
time, so a backfill is cut into 365-day chunks. A flow SERIES report at
interval `daily` takes only 60 days -- Klaviyo answers a wider one with
`400 Cannot pass in an interval longer than 60 days for use with daily
interval` -- so inside each chunk the flow series fetches itself in <=60-day
slices and the rows are concatenated. A window's `flow_series_requests` in
`sync_jobs.result` says how many that took. Nothing else is sliced.

`KLAVIYO_DAYS_BACK` is BLANK when nobody asked. That is deliberate and it is
load-bearing: `effectiveDaysBack` lets a connection's stored `days_back` win
over the default but **not** over a depth the caller asked for. Defaulting the
variable to `'60'` in the entry point made the nightly and an explicit request
indistinguishable, and the stored 60 then swallowed the bootstrap's 365 on
every first import -- measured on production 2026-11-09, where a first sync
asked for a year and stored `2026-09-10..2026-11-08`.

## Klaviyo's app listing (OAuth)

| Listing field | Value |
|---|---|
| OAuth installation URL | `https://get-silo.com/v2/klaviyo-install.html` |
| Redirect URL | `https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/klaviyo-oauth-callback` |
| Scopes | `campaigns:read flows:read metrics:read segments:read lists:read` |

The redirect URL is hardcoded in BOTH halves of the flow (`klaviyo-oauth-start`
and `klaviyo-oauth-callback`) and Klaviyo matches it exactly, so no trailing
slash and no other spelling.

`/v2/klaviyo-install.html` exists because Klaviyo wants ONE url that starts the
install from either side, and the OAuth flow otherwise only starts from inside
Integrations, which needs a session and a chosen workspace. The page handles a
cold hit: login with a return path, the company picker if no workspace is
active, then `klaviyo-oauth-start` and a forward to Klaviyo. The last hop is
behind a click on purpose -- the visitor is told which workspace they are about
to attach before they go.

**Three things must be true before that URL completes a grant**: `KLAVIYO_CLIENT_ID`
and `KLAVIYO_CLIENT_SECRET` set as Supabase secrets, both OAuth functions
deployed, and `SILO_APP_URL` set to the customer domain -- the callback defaults
to `https://bbismblockay.github.io/financehub`, so without it a customer who
approves lands on the GitHub Pages URL rather than on get-silo.com.

## Still unverified

- **Nothing has run against a live Klaviyo account.** The contract came from
  the docs (read 2026-11-09), not from measurement. The reporting response
  shape is read tolerantly (`results`/`groupings`/`statistics` *or*
  `data`/`dimensions`/`measurements`) and a response matching neither fails
  loudly rather than reading as zero rows.
- ~~Whether `GET /api/campaigns` **requires** a filter on `messages.channel`~~
  — settled 2026-11-09: it does not, and `messages.channel` is not even an
  allowed filter field (`id`, `name`, `archived`, `builder`, `created_at`,
  `updated_at` are). The read is unfiltered, with no fallback.
- The path for a flow's message names is not settled either, so names are
  best-effort: the first refusal ends the attempt for the run and names stay
  null. No number depends on one.
- **How far Klaviyo restates conversions is undocumented.** The nightly
  re-pulls a trailing 60 days (Redo's measured answer to the same question).
  Check `klaviyo_flow_daily` after a few weeks and widen `days_back` on the
  connection row if older days are still moving.
- `revision` is pinned to **2026-10-15** in `KLAVIYO_REVISION` (and the same
  constant in `test-klaviyo-connection/handler.mjs` — they must match). A
  revision is stable for a year, then deprecated for a year. Segment and form
  reports still document a `.pre` beta revision, which is why segments are not
  synced yet.
