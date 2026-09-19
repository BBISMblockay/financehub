# Customer account onboarding

A prospective wholesale customer fills in an application on a public,
token-gated page, saves a card through Stripe Checkout in `setup` mode on the
tenant's own Connect account, and somebody in finance reviews and approves it.

Nothing here can move money. Billing still runs through `stripe-invoice`, which
is JWT-only and gated by `can_manage_client_invoices()`.

---

## What this added

| Piece | Where |
|---|---|
| Schema | `supabase/migrations/20260919140000_customer_account_onboarding.sql` |
| Public function | `supabase/functions/customer-onboarding/` (`handler.ts` + `onboarding-rules.mjs`) |
| Webhook routing | `supabase/functions/stripe-webhook/` — `connect_setup` / `connect_setup_expired` |
| Public page | `v2/customer-onboarding.html` (chrome-less) |
| Internal page | `v2/customers.html` (Pattern 1) |
| Tests | `scripts/tests/customer-onboarding{,-database}.test.mjs` |

`customer_accounts` is **SILO's first native customer master**. It links to
`ar_customers`, `quickbooks_customers` and `stripe_invoice_customers` and writes
to none of them — all three are mirrors owned by their syncs.

---

## Deploying

Merging does **not** deploy. In order:

1. **Apply the migration.**
   ```
   \i supabase/migrations/20260919140000_customer_account_onboarding.sql
   ```
   Then run `supabase/verify_v2_schema.sql`. Three checks are new:
   `Customer account onboarding`, `Customer certificate storage scope`,
   `Customer address pointer constraints`. All must read `ok`.

2. **Deploy `customer-onboarding`** (Deploy Edge Function workflow, or the CLI).
   It needs `STRIPE_SECRET_KEY` (already set) and optionally `SILO_SITE_URL`.

3. **Redeploy `stripe-webhook`.** It gained the setup-capture path. Skipping
   this is the failure mode with no symptom: applications submit, cards are
   entered at Stripe, and SILO never learns a card was saved.

4. **Add two event types to the CONNECT webhook endpoint** in the Stripe
   dashboard (not the platform one):
   - `checkout.session.completed`
   - `checkout.session.expired`

5. **Uncomment the Customers row** in `v2/nav-config.js` (gated `FINANCE_DEPTS`,
   mirroring `can_manage_client_invoices()`).

Until step 5, `/v2/customers.html` is reachable by URL for the walkthrough.

---

## The two tokens

The onboarding link is **spent** when the application is submitted, and the same
transaction issues a separate continuation for the card step.

| Token | Purpose | Life | Issued by |
|---|---|---|---|
| `onboarding` | the application form | 14 days | `create_customer_account_invite()` |
| `card_setup` | card capture + status | 2 hours | `submit_customer_account()` |

The link that sits in an inbox for a fortnight is therefore not the link that
can open a payment-method capture session. Both are sha256-hashed;
`customer_account_invites` has RLS enabled and **no policy at all**, so every
access goes through the RPCs — `org_invites`' stance.

The raw token is returned exactly once, at creation. There is no way to retrieve
it later: a second link means revoking the first.

---

## Card capture

```
consent recorded  ->  claim  ->  Stripe customer  ->  Checkout(mode: 'setup')
                                                            |
                          checkout.session.completed  <-----+
                                    |
      is this session OURS? ---- no --> stop. Nothing at Stripe is touched.
                                    | yes
      SetupIntent -> customer matches? -- no --> stop.
                                    | yes
      record the card (not default)  ->  customers.update  ->  stamp default
```

**Ownership is established before anything at Stripe changes.** A tenant owns
their Connect account outright and can run a setup-mode Checkout from their own
dashboard or another integration; those events arrive on this same endpoint and
resolve to this same company. "Setup mode, company we know" is therefore not
evidence the session is SILO's, and acting on one would re-point the invoice
default on a customer SILO was never asked about.

Things worth knowing:

- **Checkout attaches the method; it does not make it the invoice default.**
  That is a separate `customers.update` call. An invoice against a customer with
  no default payment method sits open. The card is recorded *before* that call,
  so a card attached at Stripe is never missing from SILO because a follow-up
  failed.
- **A failed default is classified, not swallowed.** A terminal refusal (Stripe
  reached the request and rejected it — a 4xx other than 429) is recorded and
  left: the row reads *"not default"*, which the customer list shows. Anything
  else — a 5xx, a rate limit, a dropped connection — is **rethrown**, so the
  webhook's own retry ledger redelivers it. Swallowing those is how a card
  becomes permanently unusable by invoice automation: the account reads
  `succeeded`, so `start_card_setup` answers `already_captured` and nothing
  ever retries.
- **A retry replays the same session, never a second one.** Only a status Stripe
  stated definitively (`expired`, or a 404 / `resource_missing`) releases the
  claim. A 5xx or a network blip refuses instead — reading it as "gone" is how a
  second live session gets opened beside one the applicant still has in a tab.
- **The certificate is recorded in two steps.** Minting the signed upload URL
  creates the tax-profile row (the storage policy needs it) but writes no path
  and no timestamp. `certificate_done` stamps those, and only after listing the
  object to confirm it exists — the page's word that its PUT succeeded is not
  taken on trust.
- **`card_setup_attempt` is what makes a restart genuinely new.** Stripe replays
  an idempotency key for 24 hours, so reusing the released attempt's key would
  hand back the *expired* session's dead URL. It is bumped only by
  `release_customer_card_setup()`, i.e. only once Stripe has said the old session
  is gone. A stale-claim **takeover keeps** its attempt, because the dead attempt
  may have created a session whose answer was lost.
- **SILO stores no card data.** Payment method id, brand, last four, expiry
  month/year. The `card_last4` column is constrained to four digits.

### Consent

`onboarding-rules.mjs` holds the authorisation text and its version, and the
**text is snapshotted** onto the account, not just the version — what matters
later is what this person read. Consent recorded against an older version does
not carry forward: re-consenting costs a checkbox.

The function stores its own constant, never what the page posted.

---

## Who can see what

| | Directory (`customer_accounts`, addresses, contacts) | Tax profile (EIN, resale id, certificate) |
|---|---|---|
| Any active member | read | — |
| `can_manage_client_invoices()` | read + **limited** write | read + write |
| Another company | — | — |

"Limited write" is literal and is a **column privilege**, not a policy: RLS
cannot scope to columns, and Supabase grants `authenticated` full DML on every
new table, so the grant is the boundary. UPDATE is granted on `legal_name`,
`dba_name`, `website` and `internal_notes`. Everything else — `status`, the
approved terms, `credit_limit`, `price_tier`, `stripe_customer_id` and the
whole card block — is writable only by the SECURITY DEFINER RPCs, so a state
change cannot happen without the validation and the append-only activity row
that go with it. INSERT and DELETE are revoked outright.

The storage policy on `customer-account-files` keys its `EXISTS` on the **tax
profile**, so the certificate object inherits that narrower gate automatically.
The object path's first segment is the customer account id; that is what the
policy reads, and it is derived from the resolved token, never from a filename.

`customer_accounts_v` deliberately carries no tax columns — only
`has_tax_profile`, since "is there one" is directory-safe and what is in it is
not.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This link has expired" | 14 days elapsed, or the invite was revoked. Mint a new one. |
| "This link has already been used" | The onboarding token was consumed by a submission. If they still need the card step, reload the URL they were left on — it carries the continuation. |
| Application submitted, card never appears | `stripe-webhook` not redeployed, or the connect endpoint is missing `checkout.session.completed`. |
| Card shows "not default" | A **terminal** refusal from `customers.update`. The card IS saved, and re-running setup is not the fix (`start_card_setup` correctly answers `already_captured`). Remedy: open the customer in the tenant's Stripe dashboard and set the default payment method there, then re-send the `checkout.session.completed` event from Stripe so SILO stamps `default_payment_method_set_at`. A **transient** failure needs nothing — Stripe redelivers and it resolves itself. |
| Certificate uploaded but finance sees none | The browser PUT did not complete, so `certificate_done` recorded nothing. That is the intended outcome: no certificate is better than a signed link to an object that was never written. Ask for it by email. |
| `no_account_for_session` in the webhook log | A setup session completed that SILO has no record of claiming. Usually a session created before a deploy. |
| `customer_mismatch` | The session's Stripe customer is not the one the account is bound to. Investigate before touching anything — bindings are write-once by design. |
| Certificate uploads but nobody can open it | The tax profile row is missing, so the storage policy's `EXISTS` finds nothing. The function writes it before minting the signed URL; a row deleted afterwards orphans the object. |

---

## What was deliberately left out

- **Vendor onboarding.** W-9, remit-to and bank/ACH details are a more sensitive
  record than a resale certificate and want their own gate. `payment_requests`
  still identifies vendors by four loose text columns.
- **Emailing the invite.** The link is copied from `/v2/customers.html`. Wiring
  it to Resend is additive and needs no schema change.
- **Writing to QuickBooks.** `quickbooks_customers` is a read-only mirror and
  there is no write path to QBO for customers. `qbo_customer_id` is a prep
  column that nothing populates yet.
- **Multiple ship-to addresses.** One of each type today
  (`customer_account_addresses_type_uidx`). Widening it is additive; the
  contacts table already allows more than one row.
