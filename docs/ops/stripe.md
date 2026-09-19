# Stripe in SILO — two surfaces, one vendor

_Last updated 2026-09-19. Status: **implementation complete, verification
pending** — nothing below has run against a live Stripe account yet. The
database layer and the pure edge-function logic are covered by automated
regressions; everything that requires real Stripe credentials is listed under
[What is still unverified](#what-is-still-unverified)._

SILO talks to Stripe for two unrelated reasons, and almost every way this can
go wrong is a confusion between them.

|                    | **Billing**                          | **Connect**                                  |
|--------------------|--------------------------------------|----------------------------------------------|
| Merchant           | SILO                                 | the tenant company                            |
| Customer           | the tenant company                   | the tenant's own customer                     |
| Money lands in     | SILO's Stripe balance                | the tenant's Stripe balance — never SILO's    |
| Credential         | platform secret key                  | platform secret key + `Stripe-Account` header |
| Page               | `/v2/billing.html`                   | `/v2/invoicing.html`                          |
| Tables             | `billing_*`                          | `stripe_*`                                    |
| Edge function      | `stripe-billing`                     | `stripe-connect`, `stripe-invoice`            |

Both are received by **one** webhook function (`stripe-webhook`), because the
two endpoints deliver the same event *types* — `invoice.paid` is a tenant
paying SILO on one and a tenant's customer paying them on the other — and the
decision of which is which belongs in exactly one place.

## Why Connect Standard

Standard accounts mean the client owns the Stripe account, keeps their own
Stripe dashboard, and carries their own liability for disputes and negative
balances. Express and Custom move the onboarding UI *and the liability* onto
the platform: SILO would be underwriting a client's chargebacks with no
mechanism to fund them.

The consequence that matters operationally: **SILO stores no per-tenant Stripe
credential anywhere.** `stripe_connect_accounts.stripe_account_id` is the whole
record, and it is useless without SILO's platform key.

## Activation sequence

Merging #728 lands the code and restores the shared navigation. It does **not**
turn Stripe on, and the two menu links stay commented out in
`v2/nav-config.js` until it is genuinely ready — a live link to a page whose
backend does not exist opens something that cannot work and cannot say why.

| # | Step | Who |
|---|---|---|
| 1 | Handler tests for all four Edge Functions | done — `scripts/tests/stripe-handlers.test.mjs` |
| 2 | Independent review on the updated head | done ×4 — the last two found races in the guards added by the round before |
| 3 | Billing and Invoicing kept out of the nav | done — commented in `v2/nav-config.js` |
| 4 | Merge #728 (restores the shared navigation) | Blake |
| 5 | Apply the migration, deploy the four functions, configure Stripe in **test mode** | Blake |
| 6 | Both walkthroughs below, against test-mode Stripe | Blake |
| 7 | Uncomment the two nav lines — a tiny activation PR | |
| 8 | Swap the test keys for live keys | Blake |

Steps 4 and 5 are deliberately separate: the merge is safe because nothing
reads these tables and no existing code path changed, while activation is the
point where untested-against-reality code meets real money.

### The two walkthroughs (step 6)

Neither has ever been run. Both need a Stripe **test-mode** key.

**A. Subscription.** Seed a plan against a test price → open `/v2/billing.html`
→ Subscribe → complete Checkout with `4242 4242 4242 4242` → confirm
`billing_subscriptions` shows `active` with the right plan and period, and
`billing_invoices` has the first invoice. Then: does the page offer *Change
plan in Stripe* rather than *Subscribe*? Does a second Checkout get refused?
Cancel in the portal and confirm the mirror follows.

**B. Connect invoicing.** Connect a test Standard account → confirm
`charges_enabled` turns true only after onboarding actually completes (leave it
half-finished once, deliberately, and check the page says so) → create a
customer → create a draft invoice → send it → pay it on Stripe's hosted page →
confirm the mirror reaches `paid`. Then the recovery paths: reload the tab
mid-create and confirm the same invoice comes back rather than a second one,
and void an invoice and confirm the mirror follows.

Anything that behaves differently from this document is the document being
wrong — it was written from the API as recalled, not as measured.

## Setup

### 1. Secrets (Supabase → Edge Functions → Secrets)

| Secret | Used by | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | all four functions | Platform account. Use a **test-mode** key until the flow has been walked end to end. |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` | Signing secret of the **account** endpoint. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `stripe-webhook` | Signing secret of the **Connect** endpoint. Must be a *different* endpoint, not the same one with Connect ticked. |
| `SILO_SITE_URL` | `stripe-billing`, `stripe-connect` | Already used by the mail functions; defaults to `https://silo-baseballism.com`. |

The two webhook secrets are what tell the two surfaces apart. If they are ever
set to the same value, a connected account's events start verifying as platform
events — which is why `stripe_resolve_event_company()` **raises** on a platform
event carrying an account id instead of attributing it.

### 2. Deploy the functions

Merging does not deploy. From a checkout of this branch:

```
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy stripe-billing
supabase functions deploy stripe-connect
supabase functions deploy stripe-invoice
```

`stripe-webhook` **must** be `--no-verify-jwt`: Stripe signs with its own
signature header, not a Supabase JWT. Its authentication is the signature
check, and a delivery verifying against neither secret is rejected with 400
before the body is read out of.

`deployment-drift-check.yml` is red for these four until this is done. That red
is the reminder, not a flake.

### 3. Register the two webhook endpoints (Stripe dashboard)

Both point at the same URL:
`https://<project>.supabase.co/functions/v1/stripe-webhook`

* **Account events** — `checkout.session.completed`,
  **`checkout.session.expired`**, `customer.subscription.*`,
  `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
  `invoice.voided`.

  `checkout.session.expired` is not optional bookkeeping. One in-flight
  subscription Checkout is allowed per company (`billing_checkout_claims`),
  and an abandoned session's expiry is what releases that claim. Without the
  event the claim is still released — the next attempt resolves the session
  against Stripe and finds it expired — but only when somebody tries again,
  so the first person to retry sees a delay rather than a URL.
* **Connect events** (tick "Listen to events on Connected accounts") —
  `account.updated`, `account.application.deauthorized`, `customer.created`,
  `customer.updated`, `customer.deleted`, `invoice.*`.

An event type SILO does not handle is recorded as `ignored` rather than
dropped, so over-subscribing is harmless; under-subscribing is what leaves the
mirror stale.

### 4. Seed the plans

`billing_plans` is global (`company_entity_id` does not exist on it) and has no
client write policy — a plan is a migration or a service-role write, on purpose:
one definition every tenant reads, and no page that can change a price.

```sql
insert into public.billing_plans
  (plan_key, title, description, stripe_price_id, unit_amount_cents, billing_interval, seat_based, sort_order)
values
  ('starter','Starter','Core finance, purchasing and reporting.','price_...',  49900,'month',false,1),
  ('growth','Growth','Everything in Starter plus Ask SILO and dashboards.','price_...', 99900,'month',false,2)
on conflict (plan_key) do update
  set title = excluded.title, description = excluded.description,
      stripe_price_id = excluded.stripe_price_id,
      unit_amount_cents = excluded.unit_amount_cents;
```

`unit_amount_cents` here is a **display copy**. The price Stripe charges is the
one on the price object; if they disagree, Stripe is right and this column is
stale. It is nullable, and null renders as "Contact us" rather than as free.

### 5. Nav

Both pages are Pattern 1 and carry nav rows in `v2/nav-config.js`:

* **Invoicing** — section `Accounting` (`Operations` on a standard profile),
  gated `departments: FINANCE_DEPTS`, which mirrors
  `can_manage_client_invoices()`. Nav gating is UX only — RLS is the boundary —
  but it keeps the link off menus whose owner would find the page empty.
* **Billing** — section `Settings`, beside Integrations, gated
  `roles: ADMIN_ROLES`, mirroring `billing_subscriptions`' `is_admin_user()`
  select gate. Settings rather than Accounting because it is account
  administration, not part of anybody's close. Changing the plan additionally
  needs `owner_admin`, which `stripe-billing` enforces server-side.

Note `v2/nav-config.js` had been deleted from the repository by `631ff17`
(2026-09-19) while every Pattern 1 page still loaded it, so no page rendered a
sidebar; it was restored in the same PR as these rows.

## How a client gets paid

1. An **owner-admin** opens `/v2/invoicing.html` and clicks *Connect Stripe*.
   `stripe-connect` creates a Standard account, **persists it before the
   redirect** (a lost redirect must resume the same account, not create a second
   merchant identity in the client's Stripe), and returns a hosted onboarding
   link.
2. Stripe returns them to `?stripe=return`. The page does **not** treat that as
   completion — Stripe reaches the return URL whether or not onboarding
   finished — it re-fetches the account and reports what Stripe says.
3. Finance (`can_manage_client_invoices()`) adds customers and creates
   invoices. Creating makes a **draft** in the client's Stripe; nothing is
   emailed until *Send*.
4. *Finalize* is the point of no return: a finalized Stripe invoice cannot be
   edited or deleted, only voided. The page says so before doing it.
5. The customer pays on Stripe's hosted invoice page. `invoice.paid` arrives on
   the Connect endpoint and the mirror updates.

## Troubleshooting

**"An invoice is stuck in the wrong state."** Press *Sync* on the row. That
re-fetches from Stripe and re-syncs; Stripe is the record and the mirror will
take whatever it says, subject only to the staleness guard below.

**"A webhook arrived but nothing changed."** Read `stripe_webhook_events`
(service role only — it is not readable from the app):

| `status` | Meaning |
|---|---|
| `processed` | handled |
| `ignored` | a type SILO does not use |
| `unresolved` | the event named an account or customer **no company here owns** — recorded deliberately, because silently dropping a payment notification is indistinguishable from never receiving one |
| `error` | either a refused delivery (mis-routed; `error_message` says how) or a handler failure |

**"A paid invoice went back to open."** It should not be able to. Every sync
stamps `stripe_synced_at` with the time of the *fetch*, returns early on
anything older, and a BEFORE UPDATE trigger drops a stale write from any writer
that goes round the functions. If you see this, that chain is broken — do not
"fix" it by re-syncing, find which writer bypassed it.

**"An invoice failed — can I just try again?"** Only if nothing was created.
`stripe_invoice_requests` records the Stripe id alongside a failure whenever the
draft already existed when the later step failed, and a request in that state is
**closed for creation**: the page surfaces the draft and asks you to finish or
void it in Stripe. Retrying would mint a new request id, therefore a new Stripe
idempotency key, and Stripe would not collapse it either — that is a second real
invoice. A failure with no id recorded is freely retryable.

**"The client says they were invoiced twice."** Check
`stripe_invoice_requests`: two rows means two deliberate creates, one row means
the guard worked and something else made the second invoice (the client's own
Stripe dashboard, most likely).

The invoicing page writes its request key to `sessionStorage` **before** the
call, so a reload resumes the same attempt instead of starting a second one,
and resolves any outstanding key against `stripe_invoice_requests` on load. In
a browser blocking site storage it says so in the status line and falls back to
per-attempt keys — the ledger still stops a double-click, but not a reload.

**"Stripe setup is already in progress" when nobody else is setting it up.**
A `stripe_connect_setup_claims` row is held for the company. A claim with no
`stripe_account_id` is retaken automatically after ten minutes. A claim that
*has* one means Stripe created an account and SILO never recorded it — the next
attempt **adopts** that account rather than creating another, so the fix is to
retry, not to clear the row. Clearing it by hand is how a tenant ends up with
two merchant accounts.

**"Can I point a company at a different Stripe account?"** Not from the app.
`stripe_sync_connect_account()` refuses to rebind a company that already has
one, in either direction (another company's account, or a second account of its
own). It is a deliberate service-role act, because the first account keeps its
invoices and customers and its webhooks would otherwise resolve to nobody.

**"Subscribe is offered but they already subscribed."** The mirror can lag: the
first Checkout completed at Stripe, its webhook has not landed, the redirect was
lost, and the local row is still the `incomplete` placeholder. `stripe-billing`
therefore **asks Stripe directly** before opening a second Checkout for a
customer it already knows, and reconciles the mirror when it finds one. A
refusal naming "a live subscription at Stripe that SILO had not yet recorded" is
this guard working; reload Billing.

**"A tenant wants to change plan."** Send them to **Manage billing** — the
Stripe billing portal, which applies Stripe's own proration. `stripe-billing`
**refuses** a Checkout session for a company whose subscription is `active`,
`trialing`, `past_due` or `unpaid`: Checkout in subscription mode always
*creates* a subscription, so a "switch" would leave the old one running and
bill for both while `billing_subscriptions` (one row per company) showed only
whichever synced last.

**Stripe retries.** SILO returns a non-2xx **only** for transient failures
(database unreachable, Stripe unreachable mid-fetch), because every handler is
an idempotent upsert and a retry is safe. A mis-routed event returns 200: it
will be exactly as mis-routed on the eighth attempt.

A retried delivery **does** re-run the handler. The claim in
`stripe_record_webhook_event` is reclaimable for a row left `error` (the
failure that asked for the retry), left `unresolved`, or stuck `received` for
more than ten minutes (an edge function killed mid-handler — the gateway stops
a request at 150s). `processed` and `ignored` are terminal and are never
re-run. Until 2026-09-19 the claim was insert-or-nothing, so the 500 asked
Stripe to retry and the retry was then discarded as a duplicate: an
`invoice.paid` could be lost for good.

**A delivery answered 409 is a LEASE, not a failure.** An attempt holds that
event and has not reported back; Stripe retries, and once the ten-minute lease
expires the retry claims it. The alternative — answering 200 — is what loses an
event when a handler fails *and* its status write fails in the same outage: the
row stays `received`, Stripe is told the work is done, and nothing reclaims it.
A 500 reading `status write failed` is the same situation from the other side.

**An `unresolved` event does not self-heal.** It is recorded and returns 200,
so Stripe will not send it again on its own. If the cause was timing — the
tenant finished Connect onboarding a moment after the event fired — **resend it
from the Stripe dashboard**; the reclaim path above then processes it normally.
The alternative, 500-ing every foreign event, would retry eight times for every
event belonging to an account that was disconnected or never ours.

## What is still unverified

Everything below needs live Stripe credentials and has not been exercised:

* The signature-verification path against a real `stripe-signature` header,
  including the two-secret fallback that decides which endpoint delivered.
* The exact shape of a live `account.updated` payload against
  `stripe_sync_connect_account()` — in particular `requirements.disabled_reason`
  on a genuinely restricted account.
* Whether the pinned SDK (`npm:stripe@17.7.0`) still returns
  `invoice.subscription` and top-level `current_period_*` on the API version
  the account is actually on. `stripe_sync_subscription()` reads the item-level
  period as a fallback, so a mismatch should degrade rather than write NULL —
  but that fallback has only been tested against a synthetic payload.
* Checkout → `checkout.session.completed` → subscription mirror, end to end.
* Which Stripe SDK errors carry a `statusCode` / `resource_missing` code. The
  session lookup treats ONLY a definitive 404 as "this session is gone" and
  refuses on anything else, so a wrong guess is fail-closed (a refused
  checkout, never a duplicate) — but it has been driven only by synthetic
  errors.
* The checkout claim against real sessions: that a resumed `open` session's URL
  still works when handed back, and that Stripe reports `expired` on the
  timetable assumed here. Both are exercised by opening Checkout, abandoning
  it, and reopening Billing.
* Connect onboarding on a real account, including the expired-link
  (`?stripe=refresh`) path and the adopt-after-crash path.
* **The same 24-hour boundary on invoice create.** An `ambiguous` ledger row
  keeps its request id so the retry replays the same Stripe idempotency key,
  but Stripe only replays that response for 24 hours. A lost answer whose
  retry lands a day later can still produce a second draft. The row stays
  `ambiguous` until somebody retries, and the page names the invoice list as
  the place to check first, which is the only real defence past that window.
* **The 24-hour boundary on Connect create.** `accounts.create` carries a
  company-scoped Stripe idempotency key, so a lost response followed by a retry
  returns the same account rather than opening a second merchant identity.
  Stripe replays that response for 24 hours. A lost response whose retry lands
  more than 24 hours later could still duplicate, and nothing here can close
  that — Stripe's account listing cannot be searched by metadata. Recorded
  rather than papered over; in practice the ten-minute claim puts the retry
  minutes away, not days.
* **The real shape of an invoice line.** `stripe_decimal_cents` reads
  `unit_amount_excluding_tax` as a decimal string because that is what Stripe
  documents, and the suite pins `"20"` and `"150.5"`. A live metered or tiered
  price has not been mirrored, so the decimal places Stripe actually sends on
  one are unconfirmed — a value that is not an exact minor unit mirrors as
  null (unknown) rather than raising, which is the safe direction but is still
  a gap in the mirror.
* **Which failures `invoices.create` reports as 4xx.** The ledger distinguishes
  "Stripe refused it" (re-claimable) from "we never heard" (keep the key) by
  HTTP status, and the suite drives that with synthetic errors. A real
  timeout's shape under `npm:stripe@17.7.0` — whether it surfaces a status at
  all — has not been observed.

* Any tax behaviour. Stripe Tax is **not** enabled by these functions; invoices
  carry whatever tax settings the client's own Stripe account applies, and
  `stripe_invoices.tax_cents` is mirrored, never computed here.
