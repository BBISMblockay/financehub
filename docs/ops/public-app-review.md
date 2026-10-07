# Public Shopify app + Meta app review — submission kit

Goal: a tenant connects Shopify and Meta with one click, with no Dev Dashboard app and no
pasted System User token. Both need a public listing approved by the platform.

**Status (2026-10-07): implementation complete, verification pending.** Everything below is
ADDITIVE. The current flows (typed shop domain, store-owned Dev Dashboard app, pasted
`shpat_` / System User token) are untouched and keep working. The new code is not linked
from Integrations. Activating it is a separate small PR (see the end of this file), after
both reviews pass.

Nothing here is deployed or applied. Each step marked **[Blake]** needs your approval in
the session, or is something only you can do in a platform dashboard.

| | Shopify | Meta |
|---|---|---|
| New code | `shopify-app-install`, `shopify-install-claim`, `/v2/shopify-install.html`, migration `20261007120000` | `meta-oauth-start`, `meta-oauth-callback`, migration `20261007130000` |
| Pricing on the platform | **Free** (decision 2026-10-07: SILO bills on Stripe) | n/a |
| Owner | Baseballism's Shopify Partner organization | A separate **SILO** app inside Baseballism's Meta business portfolio (decision 2026-10-07) |
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

### 2.1 Create the app [Blake]

1. developers.facebook.com → Create app → type **Business**. Name **SILO**, owned by
   Baseballism's business portfolio, separate from the existing internal app.
2. Add the products **Facebook Login for Business** and **Marketing API**.
3. App settings → Basic:
   - Privacy Policy URL `https://get-silo.com/legal/privacy.html`.
   - User data deletion: choose **Data deletion instructions URL** and enter
     `https://get-silo.com/legal/privacy.html#data-deletion`.
   - Add an app icon, choose a category, and verify the domain `get-silo.com`.
4. Facebook Login for Business → Settings → Valid OAuth Redirect URIs:
   `https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/meta-oauth-callback`.
5. Facebook Login for Business → **Configurations → Create**:
   - Token type: **System-user access token**, which never expires.
   - Assets: Ad accounts, Pages, Instagram accounts.
   - Permissions: `ads_read, business_management, pages_show_list, pages_read_engagement,
     read_insights, instagram_basic, instagram_manage_insights` (`META_PERMISSIONS`).
   - Copy the **Configuration ID**.
6. Leave **"Require App Secret" OFF**. The nightly sync does not send `appsecret_proof`.
7. **Business Verification** for Baseballism's portfolio, if it isn't verified already
   (Business Settings → Security Center).

### 2.2 Secrets and deploy [Blake — approval needed]

1. Edge-function secrets: `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`.
2. Apply `20261007130000_meta_oauth_states.sql`, then run verify. The `meta_oauth_states`
   row must read `ok`.
3. Deploy `meta-oauth-start` and `meta-oauth-callback`. The callback deploys public.
4. Test while the app is in Development mode, using an account with a role on the app.
   Run, from a signed-in SILO admin's browser console on Integrations:
   `fetch(SUPABASE_URL + '/functions/v1/meta-oauth-start', {method:'POST', headers:{Authorization:'Bearer '+token, apikey}, body: JSON.stringify({company_entity_id})})`.
   Open the returned URL and approve. You should land back on Integrations with the account
   picker open. Check that the row's `meta->oauth->token_type` is `system_user` and that
   `token_expires_at` is null.

### 2.3 App Review submission

Request **Advanced Access** for each permission below, plus Marketing API **Ads Management
Standard Access**. Use one screencast covering all of them.

| Permission | How SILO uses it (paste into the review form) |
|---|---|
| `ads_read` | Reads campaign, ad set and ad performance and ad creative for the ad accounts the business selects, to show them their own ad spend and results beside their sales in SILO. Read-only; SILO never creates or edits ads. |
| `business_management` | Required by Facebook Login for Business to read the assets the business granted (its ad accounts and Pages) and to issue the system user token the overnight sync uses. |
| `pages_show_list` | Lists the Pages the business granted so the admin can pick which Page's insights to show. |
| `pages_read_engagement` | Reads the selected Page's posts and their engagement for SILO's organic marketing report. |
| `read_insights` | Reads Page insights (reach, views, engagement) for the selected Page. |
| `instagram_basic` | Reads the connected Instagram professional account's media list. |
| `instagram_manage_insights` | Reads insights for that media (views, reach, engagement) for SILO's organic report. |

**Screencast (about 3 minutes, English UI, show the URL bar):**

1. Sign in to SILO as an admin. Open Settings → Integrations and click **Connect Meta**.
   *(This button is part of the activation PR. For the recording, use a review build where it
   is visible, or tell the reviewer the start URL.)*
2. On the Facebook Login for Business dialog, choose the business and select an ad account,
   a Page and an Instagram account. Approve.
3. Back in SILO, pick the ad account in the account picker and click Test, which shows
   "connected".
4. Show the Marketing Report or Ad Studio using the ad data (`ads_read`).
5. Show the organic section: the Page posts and insights, then the Instagram media and
   insights.
6. Show Integrations → Remove connection, and the privacy policy's deletion section.

**Reviewer access:** a SILO demo workspace login (the same one as Shopify), plus a Meta test
user or a Business Manager that has an ad account and Page with some activity. Meta rejects
reviews that show empty data.

### 2.4 Known limits

- If the configuration is ever switched to a user token, the callback stores a roughly
  60-day token, records its expiry and marks `meta.oauth.token_type = 'user'`. Nothing
  refreshes it. Keep the configuration on the system user token type.
- Advanced Access is subject to Meta's ongoing review. Keep the privacy policy and the
  deletion URL live.

---

## Part 3 — Activation (a later, separate PR; only after both approvals)

- **Integrations / Shopify:** add a **"Install from Shopify"** button that opens the App Store
  listing URL. Leave the typed-domain and Dev Dashboard forms in place for stores already
  connected that way.
- **Integrations / Meta:** add **"Connect Meta"** next to "Add Meta Ads token…". It calls
  `startAdOauth('meta-oauth-start', { company_entity_id })`, the same helper Google uses. For
  `meta_ads` rows, add a **Reconnect** button that passes `connection_id`.
- Update `v2/integration-guides.js`, `docs/ops/shopify-sync.md` and
  `docs/ops/ad-platform-api-setup.md` to name the one-click route first.
