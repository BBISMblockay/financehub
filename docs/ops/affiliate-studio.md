# Affiliate Studio

A marketing module for any SILO company: find creators, recruit them with the
brand's own outreach, onboard them on terms they accept, credit orders that
carry their Shopify discount code, and pay commission by hand from an
append-only ledger. Staff page: `/v2/affiliates/index.html` (by URL; its
sidebar row is hidden for now). Affiliate-facing pages, outside SILO's navigation and never
indexed: `/v2/affiliates/join.html`, `portal.html`, `apply.html`.

Nothing in the module is company-specific. Every name, rate, date, niche and
search is a row; Baseballism is the pilot only because it is the first company
to create a program.

## What each part is, honestly

The Overview tab shows these labels per company, computed from that company's
own data (`stageLabels()` in `v2/affiliates/studio-core.js`).

| Part | Label | What that means |
|---|---|---|
| Discovery | **verified** once a live run succeeds; **simulated** while only dry runs exist; else **unconfigured** | Public Google results through DataForSEO, the SERP vendor SILO already pays for. Only result titles, snippets and URLs are read; SILO never visits or scrapes a profile |
| Outreach to prospects | **manual** | SILO drafts, approves and exports. A person, or the person's own AI with the opt-in `outreach:send` scope, sends from their own inbox or DMs and marks each message sent, with evidence. **SILO never emails a prospect**, through Resend or anything else |
| Affiliate emails | **verified** once one is delivered; else **unconfigured** | Resend, transactional only: signup confirmation, portal links, codes and links, payout status. Only to people who accepted terms or asked for a link |
| Code tracking | **verified** once a code is seen on an order | Existing Shopify discount codes, read from synced orders. No Shopify write scope; SILO never creates or edits a discount |
| Trackable links | **manual** | UTM-tagged destinations. No redirector, no click counting, no commission on a link |
| Commissions | **verified** once a ledger line exists | Computed in Postgres from synced orders |
| Payouts | **manual, or PayPal** | Manual: SILO builds, approves and exports; a person pays elsewhere and records the reference. PayPal (20261113050000): the company's own PayPal business account pays their affiliates |
| Stripe Connect payouts | **unconfigured** | Designed, not built -- it would make SILO the payer of record (see below) |
| Incremental sales | **not measured** | A code on an order credits the affiliate. That is not proof the affiliate caused the sale |

## Setup (per company)

1. Apply the four migrations, in order (links in the PR). Nothing turns on.
2. Deploy `affiliate-portal`, `affiliate-invite` and `ad-platform-sync-run` with
   the "Deploy Edge Function" workflow from `main`. Neither new function needs a
   `NO_JWT_FUNCTIONS` entry: the affiliate pages send the project's anon key,
   which the gateway accepts, and the handler never treats it as an identity.
3. Secrets already in place: `RESEND_API_KEY`, `SILO_APP_URL` (edge functions),
   `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` (repo secrets, used by the SEO SERP
   sync). With no Resend key, acceptance still works and each skipped email is
   recorded as `skipped` with the reason.
4. An owner or executive opens `/v2/affiliates/index.html` (by URL; the sidebar
   row is hidden for now), creates a program
   (status draft), writes the terms, and optionally grants Affiliate Studio to
   others on the Program tab.
5. Add one or more searches on the Prospects tab.
6. Make the program **active** when it should recruit. Discovery, approving
   outreach, joining and applying all skip or refuse a program that is not
   active.
7. **One search** (Blake, 2026-11-10): the Prospects tab has a single **Find
   creators** button (`affiliate-research`). Each run first runs up to 3 of
   the program's enabled saved Google searches plus the "who are you looking
   for" text as one more, hands the profiles found (up to 40) to the AI as
   leads, and the AI checks each one and keeps searching beyond them. A lead
   is stored ONLY if the AI records it; it then counts as found because a real
   search returned it. Saving a search no longer runs it on its own, and the
   page has no separate Search now. The **Affiliate discovery** workflow is no
   longer scheduled (it would write unchecked results); `affiliate-discovery-run`
   stays deployed but nothing on the page calls it. Dispatch the workflow with
   `dry_run: true` to print a plan for support.
   Every search is pinned to creator profiles: the words are sent with Google
   `site:` filters for the search's Platform, else the program's ticked social
   platforms, else all of them (`searchKeyword()` in the core). Platform
   "websites" (or a program that ticked only blog/web) runs unpinned, and a
   query that already has its own `site:` filter is sent as written.
   YouTube and TikTok are pinned to profile paths (`site:youtube.com/@`,
   `site:tiktok.com/@`), because video links name no channel and are dropped.
   Google redirect results (`https://google.com/goto?url=CAES…`, domain
   reported as google.com, seen from late October 2026) are read from the
   result's breadcrumb (`https://www.tiktok.com › @name`); a shortened
   breadcrumb segment is dropped rather than guessed, and the redirect URL
   is kept in `evidence.google_redirect_url`.

## AI research and list import

- **Find creators with AI** (Prospects tab, `affiliate-research`, action
  `research`): Claude searches and reads public pages for the program's niche,
  audience, platforms and the optional focus text, then returns a list through
  a strict tool. SILO keeps a creator only when the web tools' RESULTS showed
  its profile URL, its `@handle` or its address; the model's own words never
  count. Follower counts and emails are kept only with a source URL those
  results returned (`evidence.followers_source_url`), else stored as null.
  Likely minors are refused. A run keeps searching in further rounds until
  it has the number asked for (5 to 50), or until it is within 75 seconds of
  its time budget; a round that fails keeps what earlier rounds found. No
  single outside page supplies more than 5 creators, and follower counts
  come from the creator's own profile where it shows one
  (`evidence.followers_source_kind` = `profile` or `other_page`, shown on the
  page as "on their profile" / "from another page"). One research per program at a time; it runs in
  the background (a few minutes) and the page watches the run row
  (`affiliate_discovery_runs.provider = 'anthropic'`). Skipped counts are in
  that row's `error` text (`skipped: …`). AI credit feature
  `affiliate_research`; free when nothing is kept.
- **Import a list** (action `import`): a CSV with one creator per row and a
  profile link column (`url`, `profile_url`, `profile` or `link`). Also read
  when present: `name`, `platform`/`primary`, `followers`/`followerNum`,
  `email`/`contact`, `fit_reason`/`fitWhy`/`focus`, and `minor` (TRUE rows are
  skipped). The page sends 200 rows a request; the function takes up to 500.
  Imported follower counts are shown as "from your list", not as verified.
- Both write through `upsertCandidates`, so the do-not-contact list applies
  and a later run never blanks a value an earlier run recorded.

## Daily use

The page has four tabs (Blake, 2026-11-10: "a consumer product, not so many
inputs"): **Find creators** (was Prospects), **Messages** (was Outreach),
**Affiliates**, and **Payouts** (Commissions and Payouts together, with one
Update commissions button). Program settings sit behind the **Settings**
button. Everything secondary (saved searches, list import, adding by hand,
run history, do-not-contact, date ranges, periods, the ledger, advanced
program settings) is under a closed **More options** on its tab. A one-line
**Next** bar under the KPIs names the most useful thing to do now. Approving
a creator drafts their message.
On Messages, sending through the company's own connected AI (scope
`outreach:send`, from their own mailbox) is the main path; exporting to send
by hand is the secondary button.

- **Prospects**: review each prospect against the search result it came from
  (title, snippet, URL, date). Approve, reject, or put them on the
  do-not-contact list. "Fit" is a 0–1 score from the result alone, always with
  its written basis.
- **Outreach**: draft (template filled from the program), edit, approve,
  export. The export mints a 14-day personal signup link per person with an
  email and downloads a CSV whose SHA-256 is stored on the batch. Send, then
  mark each message sent with evidence. Replies, declines and bounces are
  recorded; "asked to stop" also adds them to the do-not-contact list.
- **Outreach through your own AI (optional)**: approve a connection on
  Settings, Connect AI with "send affiliate outreach" ticked (`outreach:send`,
  two-step login, off by default). The AI then claims approved drafts
  (`claim_outreach_to_send`), sends each from YOUR mailbox, and marks it sent
  with evidence (`mark_outreach_sent`). Claims count toward the 50 writes per
  connection per day; drafts and batches show "Via <app>". SILO itself still
  sends nothing to prospects.
- **Affiliates**: appear when an invitee opens their link. They become
  **active** only by accepting the current terms version on `join.html`. Give
  each one a code (Affiliate, Code, Add; dates, "In Shopify" and percent off
  sit under Options, percent defaults to 10). Either it already exists in
  Shopify ("I made it"), or **"My AI makes it"** (the default when a
  connection with `codes:create` exists): the code is saved as `pending`,
  which earns nothing and is handed out nowhere, until the person's own AI
  (`affiliate_codes_to_create`, then `mark_affiliate_code_created` with the
  Shopify discount id) creates it in their store. That makes it active, shown
  as "created via <app>". SILO holds no Shopify write access.
- **Store address (Share tab)**: every affiliate link is
  `<store>/discount/CODE?redirect=<page with utm>`, which applies the code at
  checkout. `affiliate_program_store_url()` picks the store: the program's
  address, else the one Shopify domain when the company has exactly one
  active store, else none (a company with several stores types its website
  once; links stay off until then, never a guessed location store).
- **Share tab**: pick launches, products and recent ads (`ad_studio_ads(60)`,
  ads with a picture, catalog templates excluded) to show in the portal.
  Sharing an ad copies its picture from the private `ad-creative-images`
  bucket to the public `affiliate-feed-images` bucket at the same path.
- **Commissions**: matching and pricing run **automatically** -- at the end of
  every Shopify sync for the companies that run synced (short 3-day window,
  `CHAINED_LOOKBACK_DAYS`), and in the nightly `affiliate-commissions`
  workflow over 45 days, which is the pass that reverses refunds and
  cancellations that land weeks after an order. *1. Match orders* and
  *2. Calculate commissions* are still there for a date range you want now;
  re-running is always safe. Then open a review period, submit it, and have
  someone with journal-entry approval approve it.
  - Both steps are capped at **8 seconds** (PostgREST sets
    `statement_timeout=8s` on the role it connects as, and the service role
    does not lift it). `shopify_orders_co_created_coded_idx`
    (20261112220000) is what keeps the match inside that on a high-volume
    store: without it the scan detoasts `discount_codes` for every order in
    the window and is cancelled every time, in the nightly job and behind the
    button alike, so no affiliate order ever appears. If Studio shows no
    orders for a code you know sold, check that index first and look for
    `canceling statement due to statement timeout` in
    `sync_jobs` (`job_type = 'affiliate_commissions'`, whose `result.source`
    says whether it was the sync-chained or the nightly pass).
  - A lagging chained run is a GitHub Actions **warning**, not a red sync:
    the orders still imported, and the nightly run is the backstop.
- **Payouts**: build a draft payout per affiliate, approve (journal-entry
  approval), export the CSV, pay it in the bank or payment tool, then record
  the reference and evidence. Tell the affiliate from the same row.

## Architecture decisions

- **Security boundary is the database.** Every table has RLS on
  `company_entity_id = active_company_id()`. Reads are any member. Writes need
  `can_manage_affiliate_programs()` (exec/owner, or a row in
  `affiliate_program_managers` for the active company). Money needs
  `can_approve_affiliate_commissions()`, which is the same population as
  `can_manage_journal_entries()`, never `is_admin_user()`. No affiliate table
  grants anything to `anon`.
- **Affiliates are not SILO users.** They never get an auth account, a
  membership or a workspace role. Their pages authorize with a link token:
  32 random bytes, only the SHA-256 is stored, every token has an expiry, and
  all portal functions are executable by the service role only. Tokens leave
  the address bar as soon as the page reads them.
- **One rep, several brands: separate records, one menu.** A creator who reps
  two brands has two affiliate records, one per company, and that does not
  change -- a program, its codes and its ledger belong to a company, so merging
  the records would merge two companies' money. What is shared is the way in:
  the portal offers a brand menu instead of a trip back to the inbox
  (`affiliate_portal_brands`, `affiliate_portal_switch_token`, service role
  only, 20261110190000).
  Two things authorize it, and **both** are load-bearing:
  1. The session must have reached the mailbox. `mailed_to_hash` holds
     `affiliate_contact_key()` of the address a token's raw value was mailed
     to, set only by `affiliate_portal_issue_mailed_token()` -- sign-in,
     renewal, a switch, and Studio's "email portal link" (affiliate-invite
     `portal_link` with `email: true`), which mails a bound link and returns
     NO URL. A link a manager receives -- `portal_link` without `email`, the
     fallback when that mail did not go out, and the one `accept` returns to
     whoever finished a signup link -- is not bound and gets no menu.
     Otherwise a manager of company A could open a rep's company B portal.
     On an unbound portal link the header shows **Switch brand**, which opens
     the email sign-in with one line saying why, instead of hiding silently.
     The sign-in answer names the 10-minute cooldown, because a second
     request inside it is answered the same and sends nothing.
  2. The rep is identified by that **bound recipient**, not by today's
     `contact_email`, and a token whose affiliate no longer carries the address
     it was mailed to fails closed. `contact_email` is writable by any manager
     of its own company (`affiliates_write`), so without this a manager could
     hold a genuinely mailed link for an affiliate whose address they control
     and then point that affiliate at a victim's address.
  The switch mints a fresh token for the one record chosen, binds it to the
  same recipient and mails nothing, so every later read goes through
  `affiliate_portal_resolve` / `_statement` / `_feed` on that token alone: no
  session sees two brands. Both refusals are worded identically, so the menu
  stays the only way to learn what exists on an address. Regressions: `K9b`,
  `K9c`, `K9d` in `affiliate-studio-database.test.mjs`.
- **Attribution** (`affiliate_resolve_attributions`): one row per order per
  company, unique on `(company_entity_id, shop_domain, order_id)`, so an order
  is credited at most once across every program. A run from a second program
  cannot take over an order another program already holds. Seven decisions,
  each recorded: single affiliate code, the one affiliate code among several,
  two affiliates' codes (not credited), multiple codes refused
  (`single_code_only`), outside the code's dates plus grace, another currency,
  and refunds not measured. The business day is the company's timezone.
- **Commission base**: Shopify `subtotal_price` (after discounts, before tax
  and shipping) minus refunded merchandise (`refund_line_items.subtotal`, tax
  excluded), clamped at zero, in the order currency's minor units
  (zero-decimal currencies are not multiplied by 100). An order whose refunds
  were never captured is `refunds_not_measured`: recorded, not credited.
- **Ledger** (`affiliate_commission_ledger`): append-only for every role,
  service role included (trigger). Accrual writes the *difference* between what
  an order should have earned and what the ledger already holds, so a later
  refund or rate change is a new negative or positive line, never an edit.
  Manual adjustments need the money gate and a memo.
- **Payouts**: a ledger line can be claimed by one payout (unique index). Positive
  lines wait out the refund hold; negative lines are always included, so money
  known to have come back is never paid out. A line in a period that is not
  approved is not payable. A refund found after a payout shows as a negative
  balance and comes off the next payout. `mark_payout_paid` refuses any method
  but `manual` and requires a reference and evidence.
- **Money lock**: accrual, building, approving and exporting payouts take one
  advisory lock per program (`affiliate_lock_program_money`), so a refund
  accrued while a payout is being built or approved cannot slip past it.
  Approving a draft is refused if a negative line arrived after it was built
  (void it and build again).
- **Cancelled orders**: a cancelled order resolves to `order_cancelled` with a
  zero base, so anything it already earned is reversed by a negative line,
  also when its code has since been retired (a second pass works from the
  stored attribution, not from code matching). An
  affiliate who is paused or ended still gets negative lines; only new
  positive earnings stop.
- **Periods**: a period is created open, and only `affiliate_approve_period`
  approves it. An approved or paid period cannot be reopened or have its dates
  or lines changed; its note stays editable. The page's period total comes from
  `affiliate_period_totals_v`, not from the lines the page has loaded.
- **Export**: `affiliate_claim_payout_export` moves the chosen approved payouts
  to exported under one batch id and returns exactly those; the CSV is built
  from that answer, then its SHA-256 is stored with
  `affiliate_set_payout_export_fingerprint`. A payout changed since the page
  loaded is skipped and listed. *Download again* re-reads the batch and changes
  nothing.
- **Same company everywhere**: every reference between affiliate tables also
  matches on `company_entity_id` (a composite foreign key), so a row can never
  point at another company's row.
- **Applications**: a repeat application never overwrites a prospect that has
  been reviewed; the new name and email are kept in the evidence as
  `last_application`.
- **Terms**: editing the text bumps the version in the database. Acceptance
  stores the version, the signed name, IP, user agent and the SHA-256 of the
  exact text shown; a stale version is refused (`409 terms_changed`).
- **Do-not-contact**: company-wide, normalized on insert (so `@Name `,
  `https://www.Site.com/` and `name@SITE.com` all match), checked at approval,
  at signup-link creation, by discovery, by applications and before every
  affiliate email. Any member may add; only a manager may remove; nobody may edit.

## Paying affiliates: the rails

| Rail | State | How |
|------|-------|-----|
| Manual | **live** | SILO builds, approves and exports; a person pays elsewhere and records the reference. SILO moves no money |
| PayPal Payouts | **live (20261113050000)** | The COMPANY's own PayPal business account pays their own affiliates. See below |
| Stripe Connect | **designed, not built** | Would need the company to run its own Connect platform. See below |

### Why PayPal and not Stripe

A Stripe `Transfer` can only move money out of the **platform's** balance, and
there is no connected-account-to-connected-account transfer and no nested
platform. So a Stripe rail inside SILO's platform would mean SILO's balance
funds every affiliate payment: SILO fronts the cash, files the 1099-NECs (the
platform controls the pricing, so the filing obligation is the platform's),
carries loss liability on negative balances and holds a Stripe reserve. That is
SILO becoming a party to its customers' payroll, and it was rejected.

PayPal's Payouts API has no such constraint: a business sends from its own
balance, and the affiliate gives an **email address** rather than onboarding
with identity, bank details and a tax form. That is the step every affiliate
programme actually dies on, which is why this rail shipped first.

A Stripe rail is still possible in the shape where the **company** runs its own
Connect platform and SILO orchestrates it. Design:
`/mnt/project-files/specs/affiliate-stripe-payouts-design-2026-11-12.md`.

### How the PayPal rail works

1. The company requests Payouts access on their own PayPal business account
   (paypal.com/payoutsweb/landing -- PayPal emails a decision), creates an app
   in their PayPal developer dashboard, and pastes the client ID and secret
   into Pay -> Connect PayPal. Sandbox and live are separate credentials, so
   the whole flow can be proven before anything real moves.
2. The affiliate sets their payout address **in their own portal**. Staff
   cannot: the person who owns the address is the only one who can be right
   about it, and a payout sent to an address a manager typed is a payment to
   whoever holds it. It is deliberately not `affiliates.contact_email` -- where
   someone reads mail and where they take money are different facts.
3. A payout is built and approved exactly as before. *Send with PayPal* then
   sends it. Authority is `can_approve_affiliate_commissions()`, the
   journal-entry gate, asked of the database AS THE CALLER before any
   service-role call.

### What makes it safe

- **The credential is unreadable.** `affiliate_payout_connections` has no grant
  to any client role. Members read `affiliate_payout_connection_status_v`, a
  definer view with an explicit `active_company_id()` filter and no credential
  columns -- the same split as `stripe_connect_accounts` /
  `stripe_connect_status_v`.
- **A payout is never in flight twice.** An HTTP call to a payment API has
  three outcomes, not two. `affiliate_payout_sends` holds one row per ATTEMPT,
  written BEFORE the call, carrying a deterministic `PayPal-Request-Id`. A call
  that never answered is state `unknown`, and `affiliate_payout_send_claim()`
  REFUSES another attempt until it has been reconciled -- re-POSTing the same
  key returns the original batch rather than paying again. The page offers
  *Check status*, not another *Send*. PayPal also refuses a `sender_batch_id`
  reused within 30 days: that is a 4xx, and it is read as "the batch already
  exists" (the original id comes out of the error's own links), never as a
  refusal -- a refusal would release the payout for a second attempt while the
  first may already have paid. If the id cannot be recovered the attempt stays
  `unknown`, which is the state that refuses another send.
- **A batch is only read as ours if it carries our own key.** A batch id can
  reach the reconcile path from PayPal's own duplicate-rejection error, so the
  batch is checked against the `sender_batch_id` SILO chose, and the item
  against the `sender_item_id` it was sent with, before a word of the answer is
  believed. A batch or item that is not this attempt's changes nothing.
- **The replay has a 30-day shelf life.** PayPal collapses a repeated batch id
  for 30 days; past that, re-posting would create a SECOND payment, so it is
  refused and the key is named for someone to look up in their PayPal
  activity. The way out of an attempt that old is to check PayPal, then void
  the payout and build it again -- which is the one case `affiliate_void_payout()`
  lets through with an attempt still `unknown` (see below).
- **An attempt belongs to the account it was made on.** Each attempt stores its
  environment, and reconciling it against a connection for the other one is
  refused: a company that tests in sandbox and then connects live would
  otherwise have its sandbox attempts re-posted to the live account.
- **A payout with an attempt in flight cannot be voided.** A void releases the
  payout's ledger entries for the next build, which with a payment at the
  provider is the same commission paid twice. `affiliate_void_payout()` refuses
  while an attempt is `sent`, `unclaimed`, or `unknown` and less than 30 days
  old; a returned or refused one lets it through. The exception is deliberate:
  an `unknown` attempt past the duplicate window can no longer be reconciled by
  asking again, so a void with a reason is the only way out of it, and by then
  the person has had a month to see it in their PayPal activity.
- **A sandbox payment settles nothing.** PayPal's sandbox simulates the whole
  flow and moves no money, and the connect screen defaults to it, so a sandbox
  result records the ATTEMPT as paid and leaves the payout approved and still
  owed. It does not block the real payment either: a sandbox attempt never
  stands in the way of a live claim or a void, while a live attempt blocks
  everything. The page says which kind of send a button is.
- **A replay is bound to the PayPal app that made it.** The same environment is
  not the same account: connecting a different app keeps `sandbox`/`live` and
  changes the sender, and PayPal's duplicate protection belongs to the app that
  first accepted the batch. Each attempt stores the connection's
  `credential_fingerprint` -- a digest of the environment and the client id,
  DERIVED rather than allocated -- and a replay against a different fingerprint
  is refused rather than guessed at. Derived is the point: a counter has to be
  read and then written, so two connects racing for different accounts can both
  read 1 and both write 2, which would hand two PayPal apps one identity. The
  secret is deliberately not part of the digest, because the duplicate
  protection belongs to the app and not to its password: rotating a secret, or
  disconnecting and reconnecting the same app, leaves every open attempt
  recoverable instead of stranding it behind the mismatch guard.
- **The page blocks a send on the same rule the claim does.** A live attempt in
  flight blocks every send; a sandbox test blocks only another test. Treating
  any open attempt as blocking left a payout with nothing but Check status
  after a test -- and Check status cannot reconcile a sandbox attempt against
  the live account either, so the real payment was unreachable from the page
  while the database would have allowed it.
- **The locks.** `affiliate_void_payout()` takes the same
  `affiliate_lock_program_money()` the send claim takes, BEFORE it reads the
  attempts and held through the release of the items -- without it a void can
  read "no attempt", a claim can slip in, and the freed commissions can be paid
  again while the first payment is in flight. `affiliate_payout_send_record()`
  selects the attempt `for update` before judging its terminal transition, so
  two overlapping polls cannot land a late PENDING on top of a committed
  SUCCESS.
- **"Paid" is the provider's word.** Only
  `affiliate_payout_send_record(state => 'paid')` marks a payout paid, with
  PayPal's own batch and item ids as the evidence. A terminal answer cannot be
  rewritten by a later poll. `affiliate_mark_payout_paid()` still refuses every
  non-manual method, so nobody can assert by hand that a machine payment
  happened.
- **Sent is not paid.** PayPal pays an email address, and an address with no
  PayPal account leaves the item UNCLAIMED for 30 days before the money comes
  back. The payout stays unpaid and the page says what it is waiting for.
- **Money conversion.** The handler's zero-decimal currency set is pinned
  identical to `affiliate_currency_minor_units()` by a test: a mismatch would
  send 100x or a hundredth of the amount owed, in real money, silently.

### Open, and worth knowing

- **PayPal does not document a platform sending payouts on a merchant's
  behalf.** Their hosted onboarding grant is documented for taking payments.
  Refersion has PayPal's "Log in with PayPal" connect flow for exactly this,
  which is a partner arrangement rather than a public API, and SILO has applied
  for it. Until then the company pastes credentials from their own app, which is
  what AffiliateWP does. The credentials are just credentials, so the connect
  screen is the only thing that changes if the application succeeds.
- **Fees** are PayPal's and the company's: a flat fee per domestic payout and a
  percentage capped per currency for international. Do not put a figure in the
  product -- PayPal's own fee page is the only authority.
- **Tax** is the company's. PayPal's own reporting does not discharge a payer's
  1099 obligation, and the product says nothing about either.
- **Webhooks are not wired.** Status is read on demand (*Check payment status*,
  and automatically straight after a send). `PAYMENT.PAYOUTS-ITEM.*` would make
  an unclaimed item that later settles update itself; until then someone has to
  press the button.

## Limitations

- `shopify-sync-run` (the edge function's older sync fork) does not capture
  codes or refunds yet; the nightly GitHub Actions sync and
  `ad-platform-sync-run` do. A missing key never clobbers on upsert.
- Orders synced before 20261110083000 have NULL codes until the sync touches
  them again; a history import fills them.
- Discovery recognises profile URLs only (YouTube, Instagram, TikTok, Twitch,
  X, Pinterest, and blogs when the program allows). No follower counts, no
  engagement, no emails it cannot see stated in the result.
- Links are not click-tracked and earn nothing.
- Reassigning a code to another affiliate for the same dates needs the old
  attributions cleared first (`affiliate_clear_attributions`, refused for rows
  the ledger cites).
- No per-affiliate commission override UI (the columns exist).
- Incrementality is not measured.

## Tests

| Suite | What |
|---|---|
| `scripts/tests/affiliate-studio-database.test.mjs` | Real PostgreSQL (PGlite), all four migrations applied twice under Supabase's default grants; tenant isolation, both gates, attribution, refunds, duplicates, ledger, periods, payouts, tokens, terms, and the verify block. 32 mutations |
| `scripts/tests/shopify-order-discount-codes.test.mjs` | The sync core's code and refund capture, its column fallback, and the pinned copy. 5 mutations |
| `scripts/tests/affiliate-discovery.test.mjs` | Discovery against a fake provider: URL recognition, cost cap, dry run, suppression, no status or contact overwrite. 7 mutations |
| `scripts/tests/affiliate-discovery-run-edge.test.mjs` | Search now: gate first, company from the caller, other-company and inactive programs refused, once a minute, counts not cost, the pinned core copy. 4 mutations |
| `scripts/tests/affiliate-edge.test.mjs` | Both edge functions: hash-only tokens, gates before service role, company from the caller, no prospect email, no draft payout news. 6 mutations |
| `scripts/tests/affiliate-studio-ui.test.mjs` | Page logic: money, form validation, CSV formula guard, fingerprints, labels. 3 mutations |
| `v2/tests/browser/affiliate-studio.test.js` | The real pages in Chromium. Includes the claim-first payout export (also with a program switch mid-claim), database period totals, the Switch brand hint and the no-store banner. Mutations listed in its header |
