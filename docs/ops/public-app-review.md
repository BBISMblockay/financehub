# Public Shopify app + Meta app review — submission kit

Goal: a tenant connects Shopify and Meta with one click, with no Dev Dashboard app and no
pasted System User token. Both need a public listing approved by the platform.

**Status (2026-10-08, 19:24 UTC evidence; callback and reviewer page revisited 2026-10-13).**
Meta: **reviewer page published; `meta-oauth-callback` deployed from `main` 2026-10-13 (2.4a,
drift check green); App Review reported submitted, approval pending**
(Part 2, 2.4a, then 2.4 and 2.8 for the earlier evidence).
Shopify: implementation complete, verification pending (unchanged since 2026-10-07). Everything below is
ADDITIVE. The current flows (typed shop domain, store-owned Dev Dashboard app, pasted
`shpat_` / System User token) are untouched and keep working. The new code is not linked
from Integrations. Activating it is a separate small PR (see the end of this file), after
both reviews pass.

**Deployment state differs by platform.** Shopify: nothing is configured, applied or deployed.
Meta: migration and secrets were reported configured earlier on 2026-10-08; the 2026-10-08
inventory evidence did not support calling the OAuth flow live (2.4); the callback answered its
no-parameter probe on 2026-10-13, which does not identify the deployed revision (2.4a). Submission is not
approval (2.8). Each step marked **[Blake]** needs your approval in the session, or is something
only you can do in a platform dashboard.

| | Shopify | Meta |
|---|---|---|
| New code | `shopify-app-install`, `shopify-install-claim`, `/v2/shopify-install.html`, migration `20261007120000` | `meta-oauth-start`, `meta-oauth-callback`, migration `20261007130000` |
| Pricing on the platform | **Free** (decision 2026-10-07: SILO bills on Stripe) | n/a |
| Owner | Baseballism's Shopify Partner organization | The existing app **1809676850412480** in Baseballism's business portfolio (decision 2026-10-08; replaces the 2026-10-07 "separate app" plan) |
| Privacy policy | `https://get-silo.com/legal/privacy.html` (Shopify section) | same, Meta section; deletion: `#data-deletion` |
| Tests | `shopify-install.test.mjs`, `shopify-install-database.test.mjs` | `meta-oauth.test.mjs` |

---

## Part 1 — Shopify public app

### 1.1 Ask Shopify about billing first (send now; it runs in parallel)

App Store requirement 1.2.1: *"Apps must use Shopify App Pricing or the Shopify Billing API
for any app charges."* SILO's app will be listed **free**, and the SILO subscription stays on
Stripe. That is the usual setup for a connector to an outside platform, but it is a judgement
call for the reviewer, so get a written answer before submitting. Draft for Partner Support
(Partner Dashboard → Support → contact):

> We are submitting a free, non-embedded public app, "SILO". It is a read-only connector: it
> brings a merchant's orders, products, inventory and Shopify Payments payouts into SILO, an
> operations and finance workspace the merchant's company already subscribes to outside
> Shopify. The app itself has no charges, no paid features and no plans. The SILO
> subscription is a separate service contract, billed by SILO. It covers many non-Shopify
> features (accounting, purchasing, HR reviews), and some customers use SILO without Shopify.
> Can you confirm that listing the app as Free, with no Billing API, meets requirement 1.2.1?
> If not, which arrangement would you accept?

If Shopify says no, the fallback is Shopify Billing for merchants who arrive through
Shopify. That is a separate build; don't start it until there's an answer.

### 1.2 App configuration (Partner Dashboard → Apps → the public app) [Blake]

| Setting | Value |
|---|---|
| Distribution | **Public** (choose *Unlisted* visibility if SILO should not appear in App Store search; review is identical) |
| Embedded in Shopify admin | **No** (`embedded = false`) |
| App URL | `https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/shopify-app-install` |
| Allowed redirection URL | the same URL (one function handles the launch and the callback) |
| Access scopes | `read_orders, read_products, read_inventory, read_locations, read_shopify_payments_payouts, read_draft_orders, read_reports, read_publications` (= `PUBLIC_SCOPES`; do not add more, since unused scopes are rejected) |
| Compliance webhooks (all three) | `https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/shopify-compliance-webhook` |
| Privacy policy URL | `https://get-silo.com/legal/privacy.html` |
| Emergency developer contact | required (4.5.6) |

**Protected customer data.** SILO stores order customer name, email and id. In Partner Dashboard → API access → Protected customer data, request **Level 1** (customer data) plus the **name** and **email** fields. Justification: "Orders are reconciled to customers in the merchant's own SILO workspace; nothing is shared or used for marketing." Without this approval, live stores return redacted customer fields.

`read_all_orders` (more than 60 days of orders) is deliberately left out of this first
submission. Request it afterwards with its own justification ("financial reconciliation
of the full order history"), once the app is approved.

### 1.3 Secrets and deploy [Blake — approval needed]

1. Edge-function secrets: `SHOPIFY_PUBLIC_CLIENT_ID`, `SHOPIFY_PUBLIC_CLIENT_SECRET`, and
   `SILO_APP_URL=https://get-silo.com` if the install page should open on that domain.
   **Setting the public keys also switches the existing in-app "Connect with Shopify" button to
   the public app** (`chooseOAuthApp` prefers it), and that button is still hidden today. If
   you set them before review passes, a domain-typed connect would use the unapproved app.
   Leave the button hidden until activation.
2. Apply `20261007120000_shopify_app_install.sql`, then run `verify_v2_schema.sql`. The
   `shopify_app_install` row must read `ok`.
3. Deploy `shopify-app-install` and `shopify-install-claim` through the Deploy Edge Function
   workflow. `shopify-app-install` deploys public (it is in `NO_JWT_FUNCTIONS`).
4. Test on a development store: Partner Dashboard → Test your app → install. You should land
   on `/v2/shopify-install.html`, choose the workspace and see "Store connected". Uninstall,
   reinstall, and confirm it says "reconnected" and sync stays as it was.

### 1.4 Listing content (drafts; edit freely)

- **Name:** SILO
- **Tagline:** Sales, inventory and payouts in your SILO operations workspace.
- **Description:** SILO is the operations and finance workspace for brands that sell on
  Shopify and beyond. Install the app to bring your store's orders, products, inventory
  by location, draft orders and Shopify Payments payouts into your SILO workspace, read-only
  and refreshed nightly. SILO uses them for sales reporting, inventory planning, purchasing
  and month-end accounting. The app never changes anything in your store.
- **Pricing:** Free to install. *(Requires an existing SILO workspace.)*
- **Support:** support@get-silo.com
- **Screencast (4.5.3), about 2 minutes:**
  1. From the App Store listing, click Install on a development store.
  2. Approve the permissions screen. Point out that every scope is read-only.
  3. You land on SILO's "Connect your Shopify store" page. Sign in with the reviewer
     account and choose the workspace.
  4. "Store connected" appears. Open Integrations and turn on sync.
  5. Show Sales and Inventory filling from the store.
  6. Uninstall from the Shopify admin, reinstall, and show the immediate OAuth and the
     "reconnected" result.
- **Testing instructions (4.5.4/4.5.5):** a reviewer login for a dedicated SILO demo
  workspace with full access. **[Blake]** Create a reviewer user that is `owner_admin` of a
  demo workspace (not Baseballism), and paste the email and password into the submission.

### 1.5 Known limits, for the reviewer notes and for us

- Opening SILO from the Shopify admin always runs OAuth again (rule 2.3.2). Shopify approves
  it silently, so the merchant just lands on the chooser and clicks "refresh".
- Someone could install SILO on their own store and send the resulting link to a SILO admin.
  Two things limit this: the page shows the store's domain and requires an explicit choice,
  and a new connection starts with sync off.
- There is no `app/uninstalled` handler. An uninstalled store's connection stays marked
  active until Shopify's `shop/redact` webhook (48 hours later) closes it. Nightly sync for
  it fails in the meantime.

---

## Part 2 — Meta app (Facebook Login for Business)

**Decision 2026-10-08:** reuse the existing Meta app **1809676850412480**, owned by Baseballism's
business portfolio (business verification complete; Tech Provider access verification in review).
This replaces the 2026-10-07 plan of a separate app.

**Status (2026-10-08, end of day): submitted to App Review, "Review in progress"** (Meta: most
reviews within 20 days). The test flow at `/testing/meta-oauth.html` is live and was verified end
to end against a real business (2.8). It is not linked from Integrations or the nav; Integrations,
the nav and every pasted System User token connection are unchanged. Code: #933, #934.

**Keep in place until Meta decides:** the reviewer login, the test connection in the "Meta App
Review" workspace, and the test page. Watch the app's Alert Inbox and `support@get-silo.com`;
answer Meta the same day.

### 2.1 How the test flow is isolated

| Layer | What enforces it |
|---|---|
| Sign-in | The page sends a signed-out visitor to `/pages/login.html?next=/testing/meta-oauth.html`. Each function verifies the JWT itself. |
| Workspace | `META_REVIEW_COMPANY_IDS` (edge-function secret, uuids). If it is unset or empty, review mode refuses everything (503). The listed workspace must be the caller's **active** workspace, and the caller must be its admin (`mayUseReviewWorkspace`). `meta-oauth-start` checks this. `meta-oauth-callback` checks it **again before exchanging the code**. `meta-oauth-review` checks it on **every** action. |
| Connection | A connection made through the page is marked `meta.oauth.review_test = true`. Every connection-level action, and a review reconnect, act only on a marked `meta_ads` row of that workspace (`isReviewConnection`). A pasted-token row never carries the mark, so the page cannot read, test, sync or change one, in any workspace. |
| State | The nonce is `rt_` + `crypto.randomUUID()`. It is stored in `ad_platform_oauth_states` and consumed once by the callback, exactly like other states. The prefix only picks the return page and adds the checks above; a forged `rt_` state finds no row. |
| Writes | The page writes nothing to the database. Asset selection goes through `meta-oauth-review`, which **re-lists** the token's assets server-side and accepts only an ad account, Page and linked Instagram account that the token can reach. It never switches `sync_enabled` on. |
| Sync | "Sync now" goes through `meta-oauth-review`, which forwards to `ad-platform-sync-run` with the caller's own JWT (RLS re-checked there). It stores daily campaign totals only. The nightly sync, which writes ad-level rows, Page insights and Instagram media, stays off for a test connection unless it is switched on separately **[Blake]**. |

Tests: `scripts/tests/meta-oauth.test.mjs` (start/callback, review mode) and
`scripts/tests/meta-oauth-review.test.mjs` (gateway, page guards). Each guard has a mutation
that must fail the suite, and CI runs them.

### 2.2 Permissions, reconciled with the code (2026-10-08)

Every Graph call SILO makes is a read. The only POSTs are Graph batch requests that wrap GETs.
Sources: `scripts/lib/ad-platforms-sync-core.mjs` (nightly / Sync now) and
`supabase/functions/test-ad-platform-connection` (discovery). Meta's requirements are quoted from
https://developers.facebook.com/documentation/development/permissions and each endpoint's
reference page.

Two different lists, not to be confused:
- **The Facebook Login for Business configuration** (2293747398051309) requests the six reporting
  permissions only: `ads_read`, `pages_show_list`, `pages_read_engagement`, `read_insights`,
  `instagram_basic`, `instagram_manage_insights`. That is what a connecting business grants.
- **The App Review request** (submitted 2026-10-08) also listed `ads_management`,
  `business_management`, `public_profile` and the Marketing API Access Tier (2.8).
  `ads_management` and `business_management` are **submitted but unused**: expect them to be
  rejected, which blocks nothing; if Meta asks, answer that SILO does not use them and they can be
  disregarded. Leave them out of any resubmission.

| Permission | SILO's actual calls | Text for the review form |
|---|---|---|
| `ads_read` | `GET /{ad-account}/insights` (daily campaign and ad-level performance); `GET /{ad-account}/ads?fields=id`; batched `GET /{ad-id}?fields=creative…` (ad creative); `GET /me/adaccounts` (listing); `GET /{ad-account}?fields=id,name,currency,account_status` (Test). Meta's Instagram media-insights reference also lists `ads_read` when the Page role comes through Business Manager. | Reads performance (spend, impressions, clicks, conversions) and ad creative for the ad accounts the business selects, and shows them beside the business's sales in SILO's marketing reports. Read-only. SILO never creates or edits ads. |
| `pages_show_list` | `GET /me/accounts?fields=id,name,instagram_business_account{id,username}`, which lists the granted Pages and each Page's linked Instagram account so the admin can choose one. | Lists the Pages the business granted, so the admin can choose which Page and linked Instagram account SILO reports on. |
| `pages_read_engagement` | `GET /{page}?fields=id,name,fan_count` (identity and follower count); `GET /{page}?fields=access_token`, the Page access token that Page Insights requires; `GET /{page}/published_posts?fields=message,permalink_url,created_time,full_picture,shares,likes.summary(true),comments.summary(true)` with the Page token (the Page's OWN posts, stored in `facebook_page_posts`). Meta's references also list it for `GET /{ig-user}/media` and `GET /{ig-media}/insights`, and as a dependency of `read_insights`. **Not `/{page}/feed`:** feed also returns posts made by visitors and needs `pages_read_user_content`, which SILO does not hold. | Reads the selected Page's name, follower count and recent published posts (text, link, date, likes, comments, shares), shown on SILO's Organic marketing report, and gets the Page access token used to read that Page's insights. It is also required for reading the linked Instagram account's media and media insights. |
| `read_insights` | `GET /{page}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements&period=day` (with the Page token). | Reads daily Page insights (media views, unique media views, post engagements) for the selected Page, for SILO's organic marketing report. |
| `instagram_basic` | `GET /{ig-user}?fields=username,name,biography,followers_count,media_count` (the account itself, stored in `instagram_account_profile`); `GET /{ig-user}/media?fields=id,media_type,caption,permalink,thumbnail_url,timestamp,like_count,comments_count`. | Reads the connected Instagram professional account's profile (handle, name, bio, follower and post counts) and its recent media list (type, caption, link, date, likes, comments), shown together on SILO's Organic marketing report. |
| `instagram_manage_insights` | `GET /{ig-user}/insights?metric=reach&metric_type=time_series&period=day` (account-level daily reach, stored in `instagram_account_insights_daily`); `GET /{ig-user}/insights?metric=views,accounts_engaged,total_interactions&metric_type=total_value` (window totals, stored on the profile row); `GET /{ig-media}/insights?metric=views,reach,shares,saved`. | Reads the account's daily reach and its views, engaged accounts and interactions for the reporting window, plus views, reach, shares and saves for each recent post, for SILO's organic report. |
| `business_management` | **No SILO call uses the Business Manager API. Not in the login configuration; was included in the App Review request (submitted but unused).** Meta's references note a possible need: IG User Media — *"If the app user was granted a role on the Page via the Business Manager, you will also need one of: ads_management business_management"*; Page — *"If using a business system user in your request, the business_management permission may be required."* | **Not needed (settled live 2026-10-08):** with the six-permission configuration, the Page token, follower count, Page insights, Instagram media and media insights all returned ok. Not used by SILO; if Meta asks, say so. The existing app permission is not removed. |
| `ads_management` | **Not used. Not in the login configuration; was included in the App Review request (submitted but unused).** Meta lists it only as an alternative to `business_management` for Instagram media, and SILO writes nothing. | If Meta asks: "SILO does not use ads_management; it never creates or edits ads. Please disregard it." Expect rejection; leave it out of any resubmission. |

*Ads Management Standard Access* is a Marketing API **feature** (rate-limit tier), not the
`ads_management` permission. It was requested in the 2026-10-08 submission as the "Marketing API
Access Tier"; nothing in the test flow depends on it.

The "Verify permissions" button on the test page runs each call above once: one ad account,
one Page, the first Instagram media item, seven days. It stores nothing and never returns a
token. Its metrics and fields are pinned equal to the sync's and the tester's by test.

### 2.3 Meta app configuration — done 2026-10-08 (Blake)

Done and verified by Blake on 2026-10-08:
- App 1809676850412480.
- Facebook Login for Business configuration **2293747398051309**: system-user token with no
  expiration, ANALYZE access (which Page Insights requires), and the six reporting permissions
  (no `business_management`).
- The callback URL `https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/meta-oauth-callback`
  passes Meta's validator.

Keep these as they are:

- Leave **"Require App Secret" OFF**: the nightly sync does not send `appsecret_proof`.
- Do **not** reset the app secret. The callback needs the current secret, and a reset may affect
  tokens this app already issued.
- Privacy policy `https://get-silo.com/legal/privacy.html`. Data deletion instructions:
   `https://get-silo.com/legal/privacy.html#data-deletion`.

Adding a product or a configuration does not change existing connections or tokens.

### 2.4a The reviewer page's 404 was the Pages build, not the callback - 2026-10-13

`https://silo-baseballism.com/testing/meta-oauth.html`, `meta-oauth.js` and
`meta-oauth-client.js` returned GitHub Pages 404. The cause was the publication change in
`71e44bf` (2026-10-09, the 2026-10-08 security audit): `_config.yml` excludes `testing`, and the
Pages build logs `EntryFilter: excluded /testing`
([build evidence](https://github.com/BBISMblockay/financehub/actions/runs/38355937398/job/115158724154)).
`_config.yml` now carries an `include` allowlist naming those three files, so they publish and
everything else in `testing/` stays private; `scripts/tests/pages-publish-allowlist.test.mjs`
("Publication tests") builds the site and proves both.

**The 404 was never a deployment problem, so it is not a reason to deploy or redeploy
`meta-oauth-callback`.** It is also not evidence that the deployed callback supports the review
flow, and the two must not be collapsed. Blake's no-parameter probe on 2026-10-13 returned the
expected `missing_params` redirect, so SOMETHING answers at the callback URL and Supabase's
function listing (2.4) was misleading about that. It cannot say WHICH revision answers: that early
return has been byte-identical since the original pre-review callback (`2657353`,
`if (!code || !state) return fail('missing_params')`), and with no `state` the redirect target is
`/v2/integrations.html` in both revisions, so a production still running the pre-review callback
passes the same probe. The review flow needs what `2d504eb` added - recognising an `rt_` state,
returning to `/testing/meta-oauth.html`, and re-checking the allow-listed workspace, the caller's
active company and their admin role BEFORE exchanging the code
(`meta-oauth-callback/handler.mjs`) - so on a pre-review deployment a reviewer could start OAuth
and be returned to Integrations, or have the review state handled by the old logic.

**Still open [Blake], and not closed by this page being published:** before Meta's reviewer runs the
flow, prove the deployed callback matches the review-supporting source on `main` - a green
`deployment-drift-check.yml` for `meta-oauth-callback`, an exact source comparison, or one
`rt_` round trip in the allow-listed workspace. Until then 2.4's deploy/verification dependency
stands. 2.4 below is kept as the record of the 2026-10-08 evidence.

**Closed 2026-10-13 16:32 UTC:** `meta-oauth-callback` deployed from `main` `e87802d` through Deploy Edge Function (run 38431297203), ACTIVE v1 with `verify_jwt=false` (start/review still `true`); the no-parameter probe returned 302 to `/v2/integrations.html?oauth_error=missing_params&platform=meta_ads`; the drift check passed (run 38431826805). Version 1 means production had no callback before this. One `rt_` round trip in the review workspace is still the only proof of the full flow [Blake].

### 2.4 Callback deployment gap - 2026-10-08

The earlier rollout report recorded a successful callback and review-page connection (2.8).
That is historical evidence, not proof of current availability. At 19:24 UTC, the production
project `mkquclffrvlzyecnabyf` function inventory omitted `meta-oauth-callback`, and fetching
that function returned `NotFoundException`. `meta-oauth-start` was ACTIVE v3 and
`meta-oauth-review` ACTIVE v4. The
[18:17 UTC drift job](https://github.com/BBISMblockay/financehub/actions/runs/37823011412/job/113468595533)
also explicitly reports the callback as not deployed. Its separate `CLAUDE.md` false positive
does not explain the missing callback. The cause and timing of the absence are unknown;
these observations do not establish that anyone deleted it.

Source inspection at `103a42465c1cf555028191e82739e9a8d8107753` found the callback entrypoint,
handler and local library present. `deploy-edge-function.yml` already includes the callback
in `NO_JWT_FUNCTIONS` on both single-function and `all` paths. Deploys are manual; merging
does not deploy. No code or packaging defect explaining the absence was identified.
Restoration requires a separately authorized deployment, not a product-code change.

**Recovery checklist [Blake; separate deployment authorization required]:**

1. Recheck the production inventory and callback source metadata. Record project, UTC time,
   deployed version and the intended `main` commit. If already restored, reconcile that
   evidence before redeploying. Do not infer availability from the earlier screenshots.
2. Deploy only `meta-oauth-callback` from the reviewed `main` commit through **Deploy Edge
   Function**, with `function_name=meta-oauth-callback` and
   `project_ref=mkquclffrvlzyecnabyf`. Do not use `all` for this recovery.
3. Confirm the callback is ACTIVE, its deployed source matches that commit, and
   `verify_jwt=false`; start/review must retain `verify_jwt=true`.
4. As a separately authorized verification step, GET the callback URL with **no query
   parameters or Authorization header**, and do not follow redirects. Expect HTTP 302,
   `Location: <SILO_APP_URL>/v2/integrations.html?oauth_error=missing_params&platform=meta_ads`
   (default origin `https://silo-baseballism.com`). This early-return probe must not consume
   state, contact Meta or modify connections. A gateway 404/401, generic redirect or inventory
   entry alone is not a pass. The local regression test checks the handler side of this probe;
   it cannot prove deployment, credentials or a full OAuth exchange.
5. Recheck drift for this function. Report unrelated drift separately. Keep public approval
   pending until Meta confirms it; do not start OAuth, reconnect, sync, select assets, rotate
   secrets, reapply migrations or change review access as part of this recovery.

Legacy pasted System User tokens and existing connections remain intact. Integrations and
navigation are unchanged. The known raw `getGraph` error exposure in
`meta-oauth-review/handler.mjs` is a separate issue, not a dependency of callback deployment.

**Original setup reference (not instructions to repeat during callback recovery):**


1. Edge-function secrets:
   - `META_APP_ID=1809676850412480`
   - `META_APP_SECRET`: the app's **existing** secret, not rotated. Enter it in the dashboard; never in chat or Git.
   - `META_LOGIN_CONFIG_ID=2293747398051309` (not a secret; it appears in the dialog URL)
   - `META_REVIEW_COMPANY_IDS=<review workspace id>`
   - `SILO_APP_URL`: optional, defaults to `https://silo-baseballism.com`, where `/testing/` is served.
2. Apply `20261007130000_meta_oauth_states.sql` (adds `meta_ads` to an allowed-values list),
   then run `verify_v2_schema.sql`.
3. Deploy `meta-oauth-start`, `meta-oauth-callback` (public, already in `NO_JWT_FUNCTIONS`) and
   `meta-oauth-review` (JWT) through the Deploy Edge Function workflow from `main`. No other
   function changes. Until all three are deployed, the drift check reports them as owed.

### 2.5 Reviewer access (resolved 2026-10-08; background kept below)

What Meta's docs say (fetched 2026-10-08):
- Reviewers test the app themselves: *"We will test your app using our own test accounts. Do not
  include your personal Meta Technologies app account's credentials."* and *"If we are unable to
  access your app to test it, your entire submission will be rejected."*
  (submission-guide, app-review/introduction)
- *"Make sure your app is in Development mode or is a Business app type."* Business apps
  *"do not have app modes and instead rely on access levels."*
- Facebook Login for Business: *"To test the business integration system user access token flow,
  the tester must have a role on the app and full control of the client business."* The docs do
  not say how a reviewer without an app role completes that flow (**unsourced; open**).
- Test users: *"We are temporarily removing the ability for apps to create new test users"*
  (test-users page, updated 2026-04-17). Whether test users work with Business apps or Facebook
  Login for Business is not documented.
- A sandbox ad account: one per app. Meta's 2023 note says Insights are not supported in the
  sandbox. The current page says it can show *"mock ad performance data."* The two conflict;
  **unverified**.
- There is no documented rule that a recording showing empty data is rejected. The permission
  screencast requirements do say, e.g. for `ads_read`: *"Showcase that the ads performance data,
  such as Impressions, Conversions, Spend, Clicks, and Reach, are displayed successfully"*, and for
  `read_insights`: *"Showcase that the insight metrics are successfully displayed."*

SILO side (verified 2026-10-08):
- A workspace needs no subscription. No page access is gated on billing, AI credit is in
  `shadow` mode, and 5 of 7 workspaces (including "Google Verification") have none.
- The precedent is the "Google Verification" workspace (`meta.isolated_review_workspace = true`),
  whose only member is one admin with no other workspace.

What was set up (2026-10-08):
1. Workspace **"Meta App Review"** (`757562df-52b9-43d1-a27a-13a7dc44367e`), created through Silo
   Admin → Platform invitations. Its only member is the reviewer login `meta-review@get-silo.com`
   (`owner_admin`, no other membership, verified in the database). The password lives only in
   Meta's reviewer-instructions field.
2. **Assets: a non-Baseballism business** (Meta business `293325484884218`): Page "Reclaimed Hair
   Salon & Spa", its Instagram account, and a new ad account `act_1656703769362753` with no
   delivery. Baseballism's assets were deliberately not connected (they would have put live
   Baseballism data in front of the reviewer login, and granted a new system user on
   Baseballism's business).
3. **Reviewer path:** the reviewer instructions point at
   `https://silo-baseballism.com/pages/login.html?next=/testing/meta-oauth.html` and say a
   connection to the sample business is already set up, so a reviewer whose own test account has
   no Page can still run **Verify permissions** on it. Whether Meta's reviewers can complete the
   system-user login themselves remains **unknown** (Meta documents no path for a tester without
   an app role).
4. **Nightly sync for the test connection: off** (`sync_enabled = false`); not switched on.

### 2.6 Reviewer instructions (draft for Platform Settings)

> SILO is a web app for operations and finance teams. Open
> https://silo-baseballism.com/testing/meta-oauth.html and sign in with the SILO account
> provided in these notes. It opens a dedicated test workspace with no customer data.
> 1. Click **Connect Meta**. Facebook Login for Business opens. Choose the business, then the ad
>    account, Page and Instagram account, and approve.
> 2. Back in SILO, under **Choose assets**, select the ad account and the Page (its linked
>    Instagram account is included) and click **Save selection**.
> 3. Click **Verify permissions**. Each row is one permission, the Graph call SILO makes for it
>    and what came back: ad account and 30-day spend/impressions/clicks (`ads_read`), the Page
>    list (`pages_show_list`), the Page token and follower count (`pages_read_engagement`), daily
>    Page insights (`read_insights`), Instagram media (`instagram_basic`) and media insights
>    (`instagram_manage_insights`).
> 4. Click **Sync now**, then **Stored data**, to see the daily campaign performance SILO stored.
> SILO only reads data. It never creates, edits or pauses ads, campaigns, budgets or assets.

### 2.7 Recording checklist

Per https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings/:
- [ ] English UI. 1080p or better; set the monitor to 1440 px wide or less. Mouse, not
      keyboard; a large cursor. No audio. **The page annotates each permission for you:** every
      permission's calls are headed by a band saying, in the customer's terms, what SILO does with
      the answer (`PERMISSION_PURPOSE` in `testing/meta-oauth-client.js`). Hold on that band before
      its rows instead of captioning in editing, and add a caption only where you want to say more.
- [ ] Start **logged out** of SILO and Facebook, and show the URL bar.
- [ ] Sign in to SILO → `/testing/meta-oauth.html` → **Connect Meta**.
- [ ] The full Facebook Login for Business dialog: business, assets, the permission list, approve.
- [ ] The return to SILO, then choosing the ad account, Page and Instagram account → Save.
- [ ] The **asset identity header** above the results: ad account name, Page name, Instagram
      @handle. Hold on it. This is the single thing every 2026-10-26 rejection asked for (2.9).
- [ ] The two **token** rows at the top of **Verify permissions**. `GET /me/permissions` lists the
      permissions the token holds as granted, declined or expired. `GET /debug_token` lists, per
      permission, the **asset ids the grant actually covers** (`granular_scopes`) — the thing
      `/me/permissions` cannot tell you. Both are worth a second of screen time: together they show
      the reviewer that the login granted what the use cases describe, for the Page on screen.
      Read them before recording — a permission that is absent, declined, or granted for a
      different Page cannot be demonstrated from this connection, whatever the UI does.
- [ ] For **each** permission, its purpose band and then its rows in **Verify permissions**, with
      real values:
      `ads_read` (account name/id/currency, then the 30-day spend/impressions/clicks row),
      `pages_show_list` (the Page list and that the selected Page is in it),
      `pages_read_engagement` (Page name, follower count, Page token issued),
      `read_insights` (the Page's name and the day-by-day values), `instagram_basic` (@handle,
      **profile fields**, then the media list), `instagram_manage_insights` (@handle,
      **account-level** reach and window totals, then media insights). Do NOT record
      `ads_management` or `business_management`: both are withdrawn.
- [ ] **Zeroes are fine, and several of these rows are zero on the review Page.** Meta's own
      `read_insights` note says so: *"zero values are acceptable if the dashboard is clearly
      labeled"*. Every row names its asset and its window, so do not go hunting for a busier Page.
- [ ] **Record the `published_posts` row, refused.** It returns `(#10) This endpoint requires the
      'pages_read_engagement' permission or the 'Page Public Content Access' feature`. As of
      2026-10-27 that is **not** a grant problem: `debug_token` shows the grant names no assets for
      any scope, including `ads_read`, whose calls succeed — so the shape of the grant cannot be
      what blocks this one call (2.9). Three other `pages_read_engagement` calls succeed on the
      same Page with the same token. Annotate the row as the call the permission is being requested
      for and leave Meta's error text on screen: a reviewer who asked to see Page content retrieved
      should see the exact request and its response, not its absence. The page prints that
      annotation under the row itself, so it is on screen without a caption. Do **not** write in the notes
      that approval alone will fix it — say what was run and what came back.
- [ ] `ads_read` in the product: Sync now → Stored data (impressions, clicks, spend by day).
- [ ] Optionally, a Reconnect, showing the same connection renewed in place.
- [ ] No secrets, tokens or reviewer passwords on screen. The page never displays a token.
- [ ] **Do not publish the app to try to make anything work.** Everything demonstrable here is
      demonstrable *because* the app is in Development mode and the recorder is an app admin;
      going Live with these permissions unapproved would likely take that away (2.9).

### 2.8 Historical verification and reported submission (2026-10-08)

The following preserves the earlier engineering rollout report. It does not supersede the
later missing-callback evidence in 2.4 and does not establish public App Review approval.

**Test connection** (review workspace only): one row, made through Facebook Login for Business,
`token_type = system_user`, `token_expires_at` null, `meta.oauth.review_test = true`,
`sync_enabled = false`. Reconnect renewed the same row (no second row). The three other Meta
connections (Baseballism, Test Company, Bat Nutz; pasted tokens) were not touched.

**Verify permissions** on that connection, all **ok**:

| Permission | Result |
|---|---|
| `ads_read` | Ad account read (name, USD, status active). Insights call succeeds with **no rows**: the ad account has never delivered |
| `pages_show_list` | 1 Page; the chosen Page is listed |
| `pages_read_engagement` | Page token issued; follower count 669 |
| `read_insights` | Daily series for all three Page metrics |
| `instagram_basic` | Recent media listed |
| `instagram_manage_insights` | Views / reach / shares / saves returned for a post |

**Found and fixed during the live run:**
- An asset the login cannot grant ("sellerdummyaccount") makes Meta's own dialog fail with
  "business assets were not granted the requested permissions". Leave it unselected.
- A login with Pages but no ad account could not save (`ad_account_id required`). #934 makes an
  ad account or a Page sufficient.

**Submitted 2026-10-08** with one screen recording (attached to each permission with timestamp
notes) and a reviewer-guide PDF. Meta's request list as submitted: `pages_show_list`,
`pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights`,
`ads_read`, plus `ads_management`, `business_management`, `public_profile` and the Marketing API
Access Tier, which were left in the request. Expected per item:
- The five Page/Instagram permissions: shown granted and used with real data.
- `ads_read`: access shown, no performance data (no delivery). May be rejected; the fix is a few
  dollars of delivery on `act_1656703769362753`, Verify → Sync now → Stored data, and a short
  clip resubmitted for `ads_read` alone.
- `ads_management`, `business_management`: **not used by SILO**; expect rejection, which blocks
  nothing. If asked: "SILO does not use these; it is read-only and its token works without them."
- `public_profile`: normally granted by default.

**After approval:** publish the app (Publish shows "Unpublished"), then Part 3's activation PR.

### 2.9 The 2026-10-08 submission's result, and what changed for the resubmission (2026-10-26)

Meta approved `pages_show_list` and `public_profile` and **rejected the other seven**: `ads_read`,
`pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights`,
`ads_management` and `business_management`. Every one carried the same code —
*Screencast Not Aligned with Use Case Details* (Developer Policy 1.6) — and every one said the same
thing: **"your apps' use case is allowed, however, the submitted screencast fails to demonstrate the
end-to-end experience"**. Nothing was wrong with the permissions SILO asks for. The video did not
show each permission's data labelled with the asset it belongs to.

Reviewer notes, and what each one actually means:

| Permission | Reviewer's note | Reading |
|---|---|---|
| `read_insights` | "We see metrics but cannot confirm which Page they belong to." | Correct, and worse than they knew: the verify row reported `{metric, points: 7}` — a COUNT of datapoints, with no values at all. |
| `instagram_basic` | "Unable to verify basic profile access… show the account selected with its handle visible, a live retrieval of profile fields (name, bio, followers), and a media list." | SILO never read the account, only its posts. |
| `instagram_manage_insights` | "The metrics displayed aren't tied to a specific account… show profile-level and media-level insights." | SILO read media-level only. |
| `pages_read_engagement` | "Unable to verify your app reading page content… show Page selection, retrieval of Page content such as posts, photos, videos, and the rendered results with the Page identity displayed." | SILO read the follower count and the Page token, never the Page's content. |
| `ads_read` | "Does not show a live creation flow… demonstrate creating a campaign, ad set, or ad." | **The note is for the wrong permission.** `ads_read` is read-only by Meta's own definition; creation needs `ads_management`. The note attached to `ads_management` ("the ad account list with its name or ID visible, selection of a single account, and the same account identity visible when you pull metrics") is the one that describes `ads_read`. |
| `business_management` | "Show the same campaign/ad in Ads Manager to confirm the publish or edit succeeded." | SILO publishes nothing. |
| `ads_management` | "Unable to verify which ad account your app connects to." | See `ads_read` above. |

**Withdrawn, not re-recorded:** `ads_management` and `business_management`. No SILO call uses either
(2.2), there is no creation flow to film, and 2026-10-08's live check already settled that the
six-permission configuration needs neither.

**Resubmit five:** `ads_read`, `pages_read_engagement`, `read_insights`, `instagram_basic`,
`instagram_manage_insights`.

**Also required by every rejection, item 5:** say that the token is a business integration **system
user** token and that the recurring pull is server-to-server, so Meta does not expect a frontend
login flow around it. The login dialog itself is still in the video.

#### What was built rather than argued

Blake's call on 2026-10-26 was to show the reviewer real data instead of explaining its absence, so
the three reads SILO never made are now part of the product (migration
`20261026210000_meta_organic_profile_and_page_posts.sql`, `scripts/lib/ad-platforms-sync-core.mjs`,
Marketing Overview's Organic tab):

- **`instagram_account_profile`** — the account's handle, name, bio, follower and post counts, plus
  Meta's `total_value` window metrics (`views`, `accounts_engaged`, `total_interactions`) with the
  window they cover. A snapshot, not a series: a follower count has no honest backfill.
- **`instagram_account_insights_daily`** — account-level `reach`, the only account metric Meta still
  serves as a time series. It is NOT the sum of the posts' reach: one person reached by two posts is
  one account-level reach.
- **`facebook_page_posts`** — the Page's own published posts from `/{page}/published_posts` with the
  Page token. `pages_read_engagement`'s reference says it "allows your app to read content (posts,
  photos, videos, events) posted by the Page", which is the reviewer's wording.

Each read fails soft (a warning and a null or an empty array, never a throw), because they were
added to the nightly job that fills the marketing reports — the 2026-08-28 lesson, where one retired
Page metric erased a successful Instagram pull from the summary. Tests:
`scripts/tests/meta-organic-account-and-posts.test.mjs` (mutation-tested, five mutations) and the
Organic-tab cases in `v2/tests/browser/marketing-launch-links.test.js`, which also cover the state
between merge and migration, where the three tables do not exist yet.

The review page now renders the selected assets **by name** above the results, and each result as
labelled fields and small tables rather than a JSON blob; `read_insights` carries the day-by-day
values. Its probe fields and metrics stay pinned equal to the sync's own by
`scripts/tests/meta-oauth-review.test.mjs`, so the screencast can never demonstrate a call the
product does not make.

Not done, and deliberately: the WOW report's Organic card still reads media insights only, and
`supabase/data_coverage.sql` was not extended (its row numbers are positional and its organic notes
are already stale — it says those tables are EMPTY, which stopped being true in May 2026).

**First live Verify run, 2026-10-26 19:33 UTC.** Eight of nine rows came back ok against the
review connection (ad account `act_1656703769362753` reclaimedhairsalon/USD, Page 105378387580746
"Reclaimed Hair Salon & Spa"/669 followers, Instagram 17841423253593547 @reclaimedhairsalon/172
followers/38 posts), which confirms live what 2.2 had only from Meta's docs: `reach` serves as
`metric_type=time_series`, and `views`/`accounts_engaged`/`total_interactions` serve as
`total_value`. The Page and Instagram day values were all zero, which Meta's own note accepts as
long as they are labelled, and they are.

The one failure was `GET /{page}/published_posts`:

> (#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content
> Access' feature.

`Page Public Content Access` is for reading **other people's** Pages and is not what SILO needs, so
it is not the answer. The first question — does the token hold `pages_read_engagement` at all — was
answered by the `token` row added to `verify` on 2026-10-26: `/me/permissions` reports it
**granted**. The second question, which that row cannot answer, is whether the grant covers *this
Page*; `granular_scopes` on `GET /debug_token` does, and a second `token` row reading it was added
on 2026-10-27, on the connection token and on the derived Page token. That row is authenticated
with the app's own credential (`app_id|app_secret`, already set for the OAuth code exchange) —
Meta refuses `debug_token` called with the token under inspection, so a self-authenticated call
never reaches `granular_scopes` at all. Which of the two remaining
causes applies, and what to record in each case, is set out at the end of 2.9.

#### What each rejection asked for, what changed, and what proves it

Every row below is from the live **Verify permissions** run on the review connection,
2026-10-27 20:18 UTC: ad account `act_1656703769362753` *reclaimedhairsalon* (USD), Page
`105378387580746` *Reclaimed Hair Salon & Spa* (669 followers), Instagram
`17841423253593547` *@reclaimedhairsalon* (172 followers, 38 posts). Meta's note on
`read_insights` settles the zeroes: *"zero values are acceptable if the dashboard is clearly
labeled"*.

| Permission | What Meta said was missing | What changed | What the live run shows |
|---|---|---|---|
| `ads_read` | The reviewer's note asked for a **campaign creation flow**. That is `ads_management`; `ads_read` is read-only, and the two notes were swapped (see below). Read as the `ads_management` note intended: which ad account the app connects to was not visible beside the metrics. | The ad account's **name and currency** are read in the same call as its status and shown in the asset header above every result. | Header: *reclaimedhairsalon · act_1656703769362753 · USD*. Rows: `GET /{act}?fields=id,name,currency,account_status` → Name reclaimedhairsalon, Currency USD, Account status 1; `GET /{act}/insights?date_preset=last_30d` → the 30-day spend / impressions / clicks row, labelled with the account name. |
| `pages_show_list` | Already **approved** 2026-10-21. Recorded only as the step that selects the Page. | — | `GET /me/accounts` → 1 Page, *Reclaimed Hair Salon & Spa*, "Selected Page is in the list: yes". |
| `pages_read_engagement` | *"We were unable to verify your app reading page content"* — wanted (1) Page selection, (2) retrieval of Page content, (3) results rendered **with the Page identity visibly displayed**. | The Page's **name and follower count are read in one call** and shown beside every Page result, instead of a bare id buried in an endpoint string. | Header: *Facebook Page — Reclaimed Hair Salon & Spa · 105378387580746 · 669 followers*. Rows: `GET /{page}?fields=id,name,fan_count` → Page name + 669 followers; `GET /{page}?fields=access_token` → Page access token issued: yes. The `published_posts` row is recorded refused with error #10, annotated as the call under review; `debug_token` rules out the grant as its cause — see below. |
| `read_insights` | *"We see metrics but cannot confirm which Page they belong to… zero values are acceptable if the dashboard is clearly labeled."* | The row carried a **count of datapoints and no values at all**. It now carries the Page's name and the **day-by-day values**. | `GET /{page}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements&period=day` → the Page named, then three metrics × six dated days, each value on screen. |
| `instagram_basic` | *"Unable to verify basic profile access"* — wanted (1) the account with its **handle** visible, (2) a **live retrieval of profile fields** (name, bio, followers), (3) a media list **labelled for that account**. | The account profile is now read **before** its posts, and the media list is labelled with the handle. Both are stored by the nightly sync in `instagram_account_profile`. | Header: *Instagram — @reclaimedhairsalon · 17841423253593547*. Rows: profile fields → Username reclaimedhairsalon, Name, Biography, Followers 172, Posts 38; media list → three posts with type, timestamp, caption, permalink, likes and comments, under "Account: @reclaimedhairsalon". |
| `instagram_manage_insights` | *"The metrics displayed aren't tied to a specific account and don't appear fetched live"* — wanted **profile-level and media-level** insights. | Only media-level insights existed. **Account-level** insights were added: `reach` as a time series, and `views` / `accounts_engaged` / `total_interactions` as window totals **with the window shown**, since a window total as a bare number is wrong by however wide the window is. | Three rows, each naming @reclaimedhairsalon: account `reach` day by day; account totals *Views 1 · Accounts engaged 0 · Total interactions 0* over *Since 2026-10-20 · Until 2026-10-26*; media insights for post `18207957895064147` → *Views 0 · Reach 43 · Shares 0 · Saved 1*. |
| `ads_management` | Asked to see the campaign visible in Ads Manager after a publish or edit. | **Withdrawn.** No SILO call writes to an ad account. | — |
| `business_management` | Asked for the same publish-then-confirm segment. | **Withdrawn.** No SILO call uses the Business Manager API. | — |

**The two notes are swapped.** `ads_read`'s note demands a creation flow, which a read-only
permission has no business having; `ads_management`'s note describes exactly what `ads_read`
does (ad account list → select one → its identity beside its metrics). Treat a reviewer note as
describing the submission, not as authoritative about which permission it belongs to.

**`published_posts` is still refused, and the asset-scoping explanation is now ruled out.** The
call returns `(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page
Public Content Access' feature`. The `debug_token` read of 2026-10-27 22:01 UTC settles what the
grant looks like, and it is not the cause:

| What was read | What came back |
|---|---|
| `/me/permissions` | `pages_read_engagement` **granted** (with `ads_read`, `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `public_profile`, `read_insights`) |
| `debug_token`, connection token | `SYSTEM_USER`, app `1809676850412480`. **Every** scope's `granular_scopes` entry names **no assets at all** — `ads_read`, `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `pages_show_list` alike |
| `debug_token`, derived Page token | type `PAGE`, the same scopes, the same empty asset lists |
| Page token issued | yes, and the Page's name, 669 followers and six days of Page insights all read with it |

**An empty asset list is not an exclusion, and `ads_read` is the control that proves it.** Its
grant has exactly the same shape — an entry naming no assets — and
`GET /{act}?fields=id,name,currency,account_status` and `/{act}/insights` both succeed against
`act_1656703769362753`. On a business integration system user token Meta simply does not enumerate
assets in `granular_scopes`, so nothing in that row distinguishes a scope whose calls work from
one whose call is refused.

**The refusal is specific to the endpoint, not to the Page, the token or the grant.** Three calls
under `pages_read_engagement` succeed on this Page with this token — identity, follower count, and
issuing the Page access token — and `read_insights` reads six dated days through that same Page
token. Only `/{page}/published_posts` refuses. Meta's error names two ways in: the permission, which
is unapproved for this app (rejected 2026-10-21 and again 2026-10-26), and `Page Public Content
Access`, which is for reading *other people's* Pages and which SILO neither needs nor requests.

What that leaves cannot be proven from this side: the evidence is consistent with the endpoint
being gated on the permission being approved, and no remaining action in SILO or in the granting
business has been shown to change it. **So record the refused row** — annotated as the call the
permission is being requested for, with Meta's error text visible — and in the notes say what was
run and what came back, nothing more. The product's `facebook_page_posts` table and its sync read
are built and fill as soon as the call succeeds.

#### Submission notes to paste

One opening paragraph on **every** permission, because item 5 of every rejection asked for it:

> SILO is a server-to-server reporting platform. The customer connects through Facebook Login for
> Business, which issues a **business integration system user token** belonging to the customer's
> own business; SILO then reads on a nightly schedule with no browser present. The screencast
> shows the full login dialog, but after that point there is no Facebook login UI to show — the
> reads happen server side. SILO only ever READS. No call in the product writes to a Page, an
> Instagram account or an ad account.

Then per permission:

- **`ads_read`** — SILO reads the connected ad account's identity and its performance so the
  customer sees spend, impressions and clicks per campaign per day in their marketing reporting.
  The screencast shows the ad account chosen by name, then the same name beside its 30-day
  figures. SILO does not create or edit campaigns; `ads_management` has been withdrawn from this
  submission for that reason.
- **`pages_read_engagement`** — SILO reads the connected Page's identity and engagement so the
  customer's organic reporting shows which Page the numbers belong to. The screencast shows the
  Page selected, then its name and follower count rendered together in the app. Reading the
  Page's published posts is part of this use case and the product stores them in a dedicated
  table. **If `published_posts` still refuses when you record:** say exactly that —
  `GET /{page}/published_posts` with the Page access token returns
  *"(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public
  Content Access' feature"*, the screencast shows that request and its response, and SILO is not
  requesting Page Public Content Access because it reads only the customer's own Page. Do not
  claim approval will resolve it.
- **`read_insights`** — SILO reads the Page's daily insights and stores them for the customer's
  marketing reports. The screencast shows the Page's name above a day-by-day table of each
  metric. The review Page is inactive, so these days read zero; every value is dated and labelled
  with the Page it belongs to.
- **`instagram_basic`** — SILO reads the connected Instagram professional account's profile and
  media so organic reporting can name the account and list its posts. The screencast shows the
  account's handle, a live retrieval of its profile fields (name, biography, followers, post
  count), and its media list, all labelled with that handle.
- **`instagram_manage_insights`** — SILO reads account-level and media-level insights for that
  same account. The screencast shows account reach day by day, the account's window totals with
  the window stated, and per-post insights, each labelled with the account's handle.

**`meta-oauth-callback` deployment, settled 2026-10-26:** production runs version 5, which IS the
review revision — `isReviewState`/`rt_` nonces, `REVIEW_PAGE_PATH = '/testing/meta-oauth.html'`, and
the allow-listed-workspace / active-company / `mayConnect` re-check before the code exchange. Read
directly from the deployed source, which closes the question 2.4a left open. `meta-oauth-review` and
`ad-platform-sync-run` DO need deploying for the changes above.

## Part 3 — Activation (a later, separate PR; only after both approvals)

- **Integrations / Shopify:** add a **"Install from Shopify"** button that opens the App Store
  listing URL. Leave the typed-domain and Dev Dashboard forms in place for stores already
  connected that way.
- **Integrations / Meta:** (only after review passes, and a separate approval) add **"Connect
  Meta"** next to "Add Meta Ads token…". It calls
  `startAdOauth('meta-oauth-start', { company_entity_id })`, the same helper Google uses. For
  `meta_ads` rows, add a **Reconnect** button that passes `connection_id`.
- Update `v2/integration-guides.js`, `docs/ops/shopify-sync.md` and
  `docs/ops/ad-platform-api-setup.md` to name the one-click route first.
