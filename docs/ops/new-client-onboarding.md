# Onboarding a new SILO client

How to stand up client #2, #3, #10 without editing application source code.

Everything below was walked against the live database on 2026-09-17. Where a
step is **not** automatic today it says so, and says who has to do it.

The headline: **creating a tenant, inviting its users, connecting its Shopify
store and running SILO's canonical reports against its data all work today with
no per-client code** — and a second tenant is already syncing nightly against
it. What has not been exercised is onboarding a tenant *from zero* since this
work; see [What is not proven yet](#what-is-not-proven-yet).

---

## The short version

| # | Step | Today |
|---|------|-------|
| 1 | Create the organization + first admin | **Automatic** — sign up at `/pages/login.html` with an org name |
| 2 | Invite the rest of the team | **Automatic** — `/v2/backend.html` → invite link |
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

One step, no operator involvement. On `/pages/login.html`, "Create account" with
an **organization name** provisions the whole tenant in a single transaction —
`handle_new_user` reads `org_name` from the auth metadata and creates:

- an `entities` row (`entity_type = 'company'`, `source = 'self_signup'`, a slug
  `entity_key` derived from the name, de-duplicated against existing keys)
- a `profiles` row with `role = 'owner'`, `department = 'exec'`, `is_active`
- an `entity_memberships` row with `role = 'owner_admin'`
- `profiles.active_company_id` pointing at the new entity

This function contains **no reference to Baseballism** and no branch per
customer. It is the strongest thing SILO currently has: tenant creation is
genuinely a product feature, not a deployment.

> **Domain note.** SILO does not key anything off the client's web domain.
> "acme.example" is not a configuration value anywhere — tenancy is the
> `entities.id` uuid, and users are bound to it by membership, not by email
> domain. There is nothing to configure for a new domain, and nothing that
> would break if two tenants shared one.

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
  gap to close.
- **Business timezone is hardcoded Pacific.** `silo_business_today()` /
  `silo_business_yesterday()` pin `America/Los_Angeles` (31 occurrences across
  migrations and edge functions). A client outside Pacific gets "yesterday"
  wrong for part of every day. This needs to read from the company record.
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
