# Public Shopify app + Meta app review — submission kit

Goal: a tenant connects Shopify and Meta with one click, with no Dev Dashboard app and no
pasted System User token. Both need a public listing approved by the platform.

**Status (2026-10-08).** Meta: **live, verified and submitted for App Review** (Part 2, 2.8).
Shopify: implementation complete, verification pending (unchanged since 2026-10-07). Everything below is
ADDITIVE. The current flows (typed shop domain, store-owned Dev Dashboard app, pasted
`shpat_` / System User token) are untouched and keep working. The new code is not linked
from Integrations. Activating it is a separate small PR (see the end of this file), after
both reviews pass.

**Deployment state differs by platform.** Shopify: nothing is configured, applied or deployed.
Meta: migration applied, functions deployed and secrets set on 2026-10-08 (2.4), and submitted to
App Review (2.8). Each step marked **[Blake]** needs your approval in the session, or is something
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
| `pages_read_engagement` | `GET /{page}?fields=access_token`, which gets the Page access token that Page Insights requires; `GET /{page}?fields=fan_count`, the follower count. Meta's references also list it for `GET /{ig-user}/media` and `GET /{ig-media}/insights`, and as a dependency of `read_insights`. **SILO does not read Page posts.** | Reads the selected Page's follower count and gets the Page access token used to read that Page's insights. It is also required for reading the linked Instagram account's media and media insights. |
| `read_insights` | `GET /{page}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements&period=day` (with the Page token). | Reads daily Page insights (media views, unique media views, post engagements) for the selected Page, for SILO's organic marketing report. |
| `instagram_basic` | `GET /{ig-user}/media?fields=id,media_type,caption,permalink,thumbnail_url,timestamp,like_count,comments_count`. | Reads the connected Instagram professional account's recent media list (type, caption, link, date, likes, comments). |
| `instagram_manage_insights` | `GET /{ig-media}/insights?metric=views,reach,shares,saved`. | Reads views, reach, shares and saves for that media, for SILO's organic report. |
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

### 2.4 Secrets, migration, deploy — done 2026-10-08 (Blake)

Applied, deployed and set on 2026-10-08. Live check: `meta-oauth-callback` answers an
unauthenticated GET with its own `302 …oauth_error=missing_params` (public, as required);
`meta-oauth-start` and `meta-oauth-review` are JWT-verified. #934's `meta-oauth-review` change is
live too: a Page-only save succeeded on the test page after it was merged and redeployed.
`META_REVIEW_COMPANY_IDS` = the "Meta App Review" workspace (`757562df-52b9-43d1-a27a-13a7dc44367e`).
Note: the Supabase function list did not show `meta-oauth-callback` right after its deploy;
probe the URL rather than trusting the list.

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
      keyboard; a large cursor. No audio. Annotate each permission.
- [ ] Start **logged out** of SILO and Facebook, and show the URL bar.
- [ ] Sign in to SILO → `/testing/meta-oauth.html` → **Connect Meta**.
- [ ] The full Facebook Login for Business dialog: business, assets, the permission list, approve.
- [ ] The return to SILO, then choosing the ad account, Page and Instagram account → Save.
- [ ] For **each** permission, the row in **Verify permissions** with real values (annotated):
      `ads_read`, `pages_show_list`, `pages_read_engagement` (Page token issued, follower
      count), `read_insights`, `instagram_basic`, `instagram_manage_insights`, plus
      `business_management` only if 2.2's live check shows it is needed.
- [ ] `ads_read` in the product: Sync now → Stored data (impressions, clicks, spend by day).
- [ ] Optionally, a Reconnect, showing the same connection renewed in place.
- [ ] No secrets, tokens or reviewer passwords on screen. The page never displays a token.

### 2.8 Live verification and submission (2026-10-08)

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
