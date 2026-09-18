# Onboarding a new SILO client

How to stand up client #2, #3, #10 without editing application source code.

Everything below was walked against the live database on 2026-09-17, and
revised on 2026-09-18 when guided onboarding shipped
(`20260918120000_company_onboarding.sql`). Where a step is **not** automatic
today it says so, and says who has to do it.

The headline: **creating a tenant, inviting its users, connecting its Shopify
store and running SILO's canonical reports against its data all work today with
no per-client code** — and a second tenant is already syncing nightly against
it. What has not been exercised is onboarding a tenant *from zero* since this
work; see [What is not proven yet](#what-is-not-proven-yet).

---

## The short version

| # | Step | Today |
|---|------|-------|
| 1 | Create the organization + first admin | **Invite-gated** — Blake mints a link at `/v2/backend.html`; the prospect completes `/v2/company-onboarding.html` |
| 2 | Invite the rest of the team | **Automatic** — `/v2/backend.html` → invite link; progress tracked on `/v2/setup-checklist.html` |
| 3 | Pick which modules they see | **Config** — `entities.meta.nav_profile`; default is the standard menu |
| 4 | Connect Shopify | **Automatic** — `/v2/integrations.html` → OAuth |
| 5 | Connect ad platforms / QBO | **Partly manual** — needs shared platform credentials in repo secrets |
| 6 | Backfill history | **Manual** — run a workflow, naming the company |
| 7 | Nightly sync | **Automatic** — picks up any connection with no code change |
| 8 | Canonical reports | **Automatic** — 21 global `system` reports scope themselves per tenant |
| 9 | Ask SILO | **Automatic** — runs under the caller's own RLS |
| 10 | Company-specific mappings (chart of accounts, channels, locations) | **Manual** — and correctly so; this is configuration, not code |

---

## 1. Create the organization and its first admin

**Changed 2026-09-18.** Company creation used to be open self-signup: "Create
account" on `/pages/login.html` with an organization name provisioned an entire
tenant. That is closed. `signUp` is a public Supabase Auth endpoint and the anon
key ships in `pages/config.js` by design, so an `org_name` posted in the signup
metadata was caller-controlled input rather than a decision SILO made — anyone
could found a tenant, on this project's Supabase and Anthropic quota. Removing
the field from the form would have changed nothing; the gate is in
`handle_new_user`, and that is where it was put.

The flow now:

1. **Blake mints an invite.** `create_platform_invite(email, company_name)`,
   gated by `is_platform_admin()` — a `platform_admins` table seeded with
   blake@baseballism.com and nobody else. Deliberately *not* "any owner_admin":
   founding a tenant is a platform act, and the owner_admin set is not a list of
   people who should be able to do it. There is no RPC that adds a platform
   admin; it takes a migration or a service-role write.
2. **The prospect opens the link** — `/v2/company-onboarding.html?invite=TOKEN`.
   If they are not signed in, the page routes through login carrying the token
   and comes back. Signing up on its own now produces a bare profile with no
   company, which sees nothing (`active_company_id()` is NULL and every
   company-scoped policy reads it).
3. **They name the company, timezone and currency**, and
   `redeem_platform_invite` creates the `entities` row, the `owner` profile, the
   `owner_admin` membership and the `company_settings` row in one transaction.
4. **They land on `/v2/setup-checklist.html`**, already active in their new
   company — no company-picker hop.

**Redemption is idempotent, not merely atomic.** Atomicity is free inside a
`SECURITY DEFINER` function; the failure it does *not* cover is the one that
actually happens — the row commits and the HTTP response is lost, so the user
presses the button again. The invite records `created_company_id` when it is
consumed, and a repeat redeem by the same user returns that company with
`repeated = true` rather than founding a second one. The token is the
idempotency key. A repeat naming a *different* company still returns the
original: a consumed invite cannot be re-aimed.

**Timezone is refused, not stored and ignored.** `silo_business_today()` /
`_yesterday()` now read `company_settings.business_timezone` instead of a
hardcoded literal — but ten other database functions and seven files under
`scripts/` and `v2/` still embed `America/Los_Angeles`, and `shopify-sync.yml`'s
cron is pinned to a UTC hour chosen because it falls after Pacific midnight. So
`supported_business_timezones` currently holds one row, and onboarding refuses
anything else **naming what does not honour it yet**. Accepting an Eastern
timezone would leave every daily figure anchored to Pacific while the settings
page claimed otherwise — a setting that reads as configured and is not.
Finishing the sweep is an INSERT into that table plus a test, not a migration
that has to re-derive which sites were fixed.

**Currency is declared, not measured — and the two are reconciled.**
`company_settings.default_currency` is what the company says it reports in.
`accounting_settings.base_currency` is *derived from QuickBooks' own trial
balance* by `seed_accounting_opening_balances`, and its row cannot exist before
a realm is connected (`qbo_connection_id` is NOT NULL). They are different
facts, so both are stored — and a trigger raises if they ever disagree, naming
both values, rather than letting the settings page and the ledger each be
quietly right about a different currency.

> **Domain note.** SILO does not key anything off the client's web domain.
> "acme.example" is not a configuration value anywhere — tenancy is the
> `entities.id` uuid, and users are bound to it by membership, not by email
> domain. There is nothing to configure for a new domain, and nothing that
> would break if two tenants shared one.

### Demo domain: get-silo.com

The application is domain-agnostic (above), but **outbound email is not**, and
it is what a prospect sees first. Three things are set outside the repo:

| What | Where | Why |
|------|-------|-----|
| Verify `get-silo.com` in Resend | Resend dashboard | Until it is verified, mail can only be sent from the Baseballism domain |
| `SILO_MAIL_FROM` edge-function secret | Supabase → Edge Functions → Secrets | Ten functions hardcoded `SILO <noreply@silo-baseballism.com>` as the sender. They now read this secret and fall back to the old literal, so nothing changes for Baseballism until it is set. A prospect receiving their team invite from a Baseballism address reads as a mistake, or as a leak of who else uses SILO |
| `SILO_SITE_URL` edge-function secret | same | The link base. Already env-driven with the Baseballism domain as fallback; no code change was needed |
| Add `get-silo.com` to the redirect allowlist | Supabase → Authentication → URL Configuration | Otherwise the login round trip and the invite links bounce |

Those ten functions must be **redeployed** for `SILO_MAIL_FROM` to take effect —
merging does not deploy. `deployment-drift-check.yml` will be red for them until
that happens, and that red is the reminder working as designed.

## 2. Invite the team

`/v2/backend.html` → create invite (`create_org_invite` RPC) → a
`/pages/login.html?invite=TOKEN` link, emailed by the `org-invite-send` edge
function with a manual-copy fallback if `RESEND_API_KEY` is unset.

- A brand-new invitee gets a "set password & join" screen (`org-invite-redeem`)
  and lands confirmed — the invite proved the address, so there is no
  confirmation email.
- An invitee who already has a SILO account signs in and the login page redeems
  via `accept_org_invite`.

Tokens are sha256-hashed in `org_invites` (RLS deny-all, RPC-only), expire in
14 days, and are email-bound.

**Do not use the access-request queue for a new tenant.** `access_requests`
accepts anonymous inserts, so anyone can put a row in any company's queue; it
exists for the legacy Baseballism flow. Invites are the supported path.

## 3. Choose the module set

New companies get the `standard` nav profile automatically — SILO's reusable
departmental menu, with Baseballism-only links (BBISM Receivables, the licensing
microsite) hidden. `grandfathered` is Baseballism's own fuller menu and should
stay that way.

To change it for a client, set `entities.meta.nav_profile` to `'standard'` or
`'grandfathered'`. That is a data change; do not add a branch to
`v2/nav-config.js`.

Nav visibility is **UX only**. The boundary is RLS. Hiding a link does not
protect anything and showing one does not expose anything.

## 4. Connect the first data source (Shopify)

`/v2/integrations.html`, admin-only. The OAuth pair
(`shopify-oauth-start` / `shopify-oauth-callback`) writes a `shopify_connections`
row stamped with the caller's active company. No developer involvement.

Per connector, as things actually stand:

| Connector | Credentials | Tenant mapping | New-tenant setup |
|---|---|---|---|
| **Shopify** | Per-connection OAuth token on `shopify_connections` | `company_entity_id` on the row | Self-serve OAuth. **Use this one for the proof.** |
| **QuickBooks** | Per-connection OAuth on `quickbooks_connections` | `company_entity_id` | Self-serve OAuth |
| **Redo** | Per-connection API + webhook secret | `company_entity_id` | Paste credentials in Integrations |
| **Meta Ads** | Long-lived System User token, pasted | `company_entity_id` | Paste token; no OAuth pair exists |
| **Google Ads / GA4 / Search Console** | Per-connection OAuth tokens, **but** the OAuth *client* is shared | `company_entity_id` | Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` as repo secrets. Connections are skipped until those exist. |
| **TikTok Ads** | Per-connection OAuth; shared app | `company_entity_id` | Needs `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` |

The shared-client-credential pattern for Google/TikTok is normal for a SaaS
(one registered app, per-customer tokens) — it is **not** cross-tenant leakage,
because the access and refresh tokens are per-connection rows. It does mean
those connectors cannot be enabled for a client until the platform app exists.

Validate before syncing: **Test connection** in Integrations
(`test-ad-platform-connection` / `test-shopify-connection`) hits the live API
and, where no account is configured yet, returns the pickable account list.

## 5. Backfill history, then let the nightly take over

Backfills are manual workflows, each now **requiring** the company id (they used
to default to Baseballism, which silently filed a new client's data under the
wrong tenant — changed 2026-09-17):

- `shopify-orders-backfill.yml` — order facts for a date range
- `search-console-backfill.yml` — up to ~500 days, newest first
- `meta-creative-backfill.yml` — creatives the nightly window never asked about
- `redo-backfill.yml`, `mailroom-backfill.yml`

The nightly syncs need **no change at all** for a new tenant.
`scripts/shopify-sync.mjs` and `scripts/ad-platforms-sync.mjs` both select every
active connection and loop, with `SHOPIFY_ONLY_COMPANY_ID` / `ADS_ONLY_COMPANY_ID`
available to narrow a manual run. A new connection is picked up on the next
scheduled run.

`sales-freshness-check.yml` will start alarming (and self-healing) for the new
tenant automatically, since it checks the newest `day_date` **per company**.

## 6. Company-specific mappings

These are genuinely per-client and should stay manual — they encode a business's
own vocabulary and no default is safe:

- `accounting_coa_map` — chart-of-accounts names, editable in
  `/v2/accounting-export.html`
- `shopify_channel_map` — Shopify's opaque `source_name` slugs → display names
- `locations` / `shopify_location_mappings`
- `card_sources` — each card's balancing account, chosen by a person from the
  pulled QBO chart (never derived from the card's name)

Leave them empty rather than guessing. Accounting Export **refuses to build**
an entry when a line is unmapped, which is the correct behaviour.

## 7. Turn on reporting

Nothing to install. 21 `source = 'system'` saved reports are **global**
(`company_entity_id IS NULL`, one definition shared by every tenant) and safe
because the SQL runs through `chat_run_readonly_query`, which is SECURITY
INVOKER — so one definition scopes itself to whoever runs it.

Measured on 2026-09-17, the same canonical report SQL, no per-tenant code:

| Run as | Top location | Net sales | Units |
|---|---|---|---|
| Test Company user | `chicago` | $170,864 | 5,730 |
| Baseballism user | `online` | $51,160,834 | 2,108,057 |

No overlap, no configuration, one report definition.

> Any *new* system report must read a `security_invoker` view or an RLS-enabled
> table, **never a materialized view** — Postgres does not enforce RLS on
> matviews, so a global definition over one would hand every tenant's rows to
> every tenant.

## 8. Ask SILO

Works for a new tenant with no setup, because every query it runs goes through
the same SECURITY INVOKER RPC. Two things are per-company **data**, not code:

- `silo_chat_notes` with `category = 'brand'` — brand identity and voice.
  Nothing about brand is hardcoded in the edge function.
- `silo_chat_managers` — who may teach it.

## 9. Audit trail

Already on, nothing to enable: `stamp_created_by` / `stamp_changed_by` triggers,
`finance_audit_events`, `silo_chat_audit_log`, `sync_jobs` per connection, and
per-module activity logs (`payment_request_activity`, `mail_item_activity`,
`comp_adjustment_request_activity`). Service-role syncs deliberately stamp null.

## 10. Declare production-ready

Run through [Acceptance tests](#acceptance-tests) below and keep the output.

---

## Acceptance tests

Run each as the **new tenant's** user, and again as a Baseballism user, in a
rolled-back transaction. Impersonation that works against the live database:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<the user uuid>","role":"authenticated"}';
-- ... assertions ...
rollback;
```

1. **Tenant resolves.** `select active_company_id()` returns the new entity.
2. **No Baseballism rows anywhere.** For each of `sales_by_day`,
   `products_master`, `payment_requests`, `po_headers`, `employees`,
   `card_transactions`: `select count(*) ... where company_entity_id <>
   active_company_id()` returns **0**.
3. **Reverse direction.** A Baseballism user sees 0 rows of the new tenant's.
4. **Canonical report.** A `system` saved report returns the new tenant's
   numbers and only those (see the table above for the shape of the evidence).
5. **Ask SILO.** Ask a question whose honest answer differs per tenant; confirm
   the figure matches assertion 4 and no Baseballism figure appears.
6. **Service-role primitives are out of reach.**
   `select purge_better_reports_overlap('<other tenant>')` must fail with
   `42501` as both `anon` and `authenticated`.
7. **The tenant boundary is not self-writable.** As the new tenant's user, each
   of these must be **refused**:
   - `update profiles set active_company_id = '<Baseballism>' where id = auth.uid()`
   - `update profiles set role = 'owner' where id = auth.uid()`
   - `insert into entity_memberships (entity_id, user_id, role) values ('<Baseballism>', auth.uid(), 'owner_admin')`

   Then confirm the same user can still save their own name and landing page,
   and that the company picker still lists their own companies. **These are the
   checks that matter most.** Until 2026-09-17 the first two succeeded; until
   2026-09-18 the third did, and the third *defeated the fix for the first two*
   — it forges nothing, it creates a real membership and then asks
   `set_active_company()` to honour it. See P0-4 and P0-5 in
   `docs/ops/multi-tenant-audit-2026-09.md`.

   The general form of this check, worth applying to anything added later:
   **enumerate every input to every authorization decision, and for each one ask
   who can write it.** In SILO those inputs are `profiles.active_company_id`,
   `profiles.role`, `profiles.department` and `entity_memberships`.
8. **Storage.** A private-bucket object under another tenant's parent row is not
   readable. See `docs/ops/storage-isolation.md`.
9. **Disconnect / reconnect.** Toggle the Shopify connection off, confirm the
   next sync skips it and leaves the data; reconnect and confirm the sync
   resumes without duplicating (every write is an idempotent upsert keyed on
   the platform's own ids).
10. **Schema drift.** `supabase/verify_v2_schema.sql` — every row `ok`, including
   *Definer functions reachable by anon*, *Service-role-only tenant primitives*,
   *No silent Baseballism fallback in RPCs*, *Profiles privilege columns are
   not self-writable* and *Membership is not self-grantable*.

---

## What is not proven yet

Being precise, because the gap between these and "multi-tenant SaaS ready" is
the whole question:

- **No tenant onboarded from zero since this work.** Note what this is *not*:
  Test Company is a live, currently-syncing second tenant. Both its Shopify
  connections are active with sync enabled, they run the full nightly job matrix
  (sales, inventory, payouts, draft orders, catalog, collections, discount
  codes, landing pages, sessions), and the last successful run finished
  **2026-09-18 01:59 UTC** — the same window as Baseballism. Seven-day record:
  658 success, 280 `skipped` (by design, the 14:30 catch-up), **zero errors**;
  Baseballism had 14 in the same window.

  Its `sales_by_day` series stops at 2025-06-20 because **those shops stopped
  selling**, not because anything is broken. An earlier version of this file
  called that "15 months stale" and inferred a dead pipeline from flat data —
  wrong, and the same error the audit is about: reading the data instead of
  measuring the mechanism.

  What is genuinely undemonstrated is the *first-run* path — a brand-new
  customer going OAuth → initial backfill → first canonical report — because
  Test Company's connections predate this work. That is a demo to record, not a
  gap to close. As of 2026-09-18 the *creation* half of it is covered by
  `scripts/tests/company-onboarding-database.test.mjs` (47 assertions against
  PGlite, thirteen mutations) plus
  `scripts/tests/onboarding-concurrency.test.mjs`, which interleaves two REAL
  PostgreSQL connections; the OAuth-to-first-report half still needs a real
  store.

  The split between those two files is not arbitrary. PGlite is a single
  connection, so it can prove a guard refuses a bad state but never that two
  sessions racing cannot assemble that state between them — and three of this
  migration's guarantees are exactly that shape. Measured 2026-09-18, each by
  removing the lock and watching the damage appear: without the per-company
  advisory lock a company commits with its books seeded in USD under a CAD
  declaration; without the profiles `FOR UPDATE` an administrator's
  deactivation is undone by the redeem it raced; without the invite row lock
  one invite founds **two** companies. CI requires each of those three
  mutations to go red, so a lock cannot be quietly dropped later and leave a
  green suite behind.
- **Business timezone: half done, and the half that is missing is refused
  rather than faked.** `silo_business_today()` / `silo_business_yesterday()` now
  read `company_settings.business_timezone` (20260918120000). Measured on
  production 2026-09-18, **ten further functions** in the public schema and
  **seven files** under `scripts/` and `v2/` still embed `America/Los_Angeles`
  in their own bodies, including the Shopify sync core and the sales-freshness
  check; `shopify-sync.yml`'s cron is pinned to a UTC hour chosen for Pacific
  midnight. Until those are done, `supported_business_timezones` holds one row
  and onboarding **refuses** anything else with a message naming why. A client
  outside Pacific therefore cannot be onboarded yet — which is the honest state,
  and is deliberately louder than storing a setting nothing honours.
- **Ask SILO's product-concept branch** is gated by a hardcoded email allowlist
  (`PRODUCT_CONCEPT_TESTERS = ['blake@baseballism.com']`) in the edge function.
  Fine while in testing; it is per-client code and must become a grant table or
  be removed before that feature ships.
- **Edge functions deploy manually.** Merging a PR does not deploy. A new tenant
  depending on a function change waits on a human.
- **`access_requests` accepts anonymous inserts with an arbitrary
  `company_entity_id`**, so anyone can enqueue a request against any company.
  Approval is still gated, so this is queue spam rather than access — but use
  invites, not access requests.
- **Google/TikTok connectors need platform app credentials** as repo secrets
  before a client can connect them at all.

## What should NOT be generalized

Not every Baseballism-shaped thing is accidental coupling. Leave these alone:

- `v2/licensing/` — an MLB licensing microsite for one licensee
- `baseballismwholesale.html` / BBISM Receivables — one company's AR flow
- `checkwriter.html` — kept deliberately as an internal tool
- the `grandfathered` nav profile itself — it is how one customer keeps a menu
  the product no longer leads with, which is exactly what per-tenant
  configuration is for
- Baseballism's seeded `accounting_coa_map` rows — per-company configuration
  that happens to have been seeded by migration
