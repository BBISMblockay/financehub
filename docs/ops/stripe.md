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
  `customer.subscription.*`, `invoice.finalized`, `invoice.paid`,
  `invoice.payment_failed`, `invoice.voided`.
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

Both pages are Pattern 1 and expect `finance/billing` and `finance/invoicing`
nav keys. **`v2/nav-config.js` is currently absent from the repository** (it was
deleted on `main` in `631ff17` on 2026-09-19), so no nav row could be added with
this change. The pages are reachable by URL and work; they will want a row under
Finance once that file is back.

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

**"The client says they were invoiced twice."** Check
`stripe_invoice_requests`: two rows means two deliberate creates, one row means
the guard worked and something else made the second invoice (the client's own
Stripe dashboard, most likely).

**Stripe retries.** SILO returns a non-2xx **only** for transient failures
(database unreachable, Stripe unreachable mid-fetch), because every handler is
an idempotent upsert and a retry is safe. A mis-routed or unresolvable event
returns 200: it will be exactly as mis-routed on the eighth attempt, and the
retries would bury the one delivery somebody needs to find.

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
* Connect onboarding on a real account, including the expired-link
  (`?stripe=refresh`) path.
* Any tax behaviour. Stripe Tax is **not** enabled by these functions; invoices
  carry whatever tax settings the client's own Stripe account applies, and
  `stripe_invoices.tax_cents` is mirrored, never computed here.
