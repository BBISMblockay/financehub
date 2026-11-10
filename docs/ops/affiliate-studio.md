# Affiliate Studio

A marketing module for any SILO company: find creators, recruit them with the
brand's own outreach, onboard them on terms they accept, credit orders that
carry their Shopify discount code, and pay commission by hand from an
append-only ledger. Staff page: `/v2/affiliates/index.html` (Marketing →
Affiliates). Affiliate-facing pages, outside SILO's navigation and never
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
| Payouts | **manual** | SILO builds, approves and exports; a person pays elsewhere and records the reference. **SILO moves no money** |
| Stripe Connect payouts | **unconfigured** | Designed, not built (see below) |
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
4. An owner or executive opens Marketing → Affiliates, creates a program
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
  each one an existing Shopify code with dates, and optionally a UTM link.
- **Commissions**: after an order sync, run *1. Match orders* then
  *2. Calculate commissions* for a date range (re-running is safe). Open a
  review period, submit it, and have someone with journal-entry approval
  approve it.
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

## Stripe Connect payouts: investigation

SILO already uses Stripe Connect, with each tenant's own **Standard** account
connected to SILO's platform (`stripe_connect_accounts`, for invoicing). That
row is never touched by this module.

Paying affiliates through Stripe would need affiliates as **Express** connected
accounts and a `Transfer` to each. Stripe transfers move money from the
**platform's** balance to a connected account; they do not move money from one
connected account (the tenant) to another (the affiliate). So within SILO's
current setup, a Stripe payout would mean SILO's own platform balance funds
every affiliate payment, which makes SILO a party to the tenant's payments.
That needs a decision before any code:

1. **Who funds transfers**: SILO collects from the tenant first, or the tenant
   runs its own Connect platform (outside SILO's keys).
2. **Tax forms**: who issues 1099-NEC for affiliates (US), and collecting W-9s
   during Express onboarding.
3. **Capabilities and countries**: `transfers` capability per affiliate country.
4. **Webhooks**: `account.updated` to mirror `payouts_enabled` into
   `affiliate_payout_accounts` (re-fetched, per the Stripe rule), and
   `transfer.*` / `payout.*` for status.

The schema is ready for it (`affiliate_payout_accounts`,
`payout_method = 'stripe_connect_express'`), and every path refuses to record a
non-manual payout as paid until it is built and verified in test mode.

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
| `v2/tests/browser/affiliate-studio.test.js` | The real pages in Chromium. Includes the claim-first payout export (also with a program switch mid-claim) and database period totals. 7 mutations |
