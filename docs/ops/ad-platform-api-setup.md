# Ad platform direct-API setup guide

One-time developer-portal setup for the direct marketing-KPI sync
(`ad-platforms-sync.yml` → `scripts/ad-platforms-sync.mjs` → `marketing_kpis_daily`).
Do these in any order; each platform activates independently. Until a platform is
set up, its connections are simply skipped — nothing breaks.

Callback URL used by every OAuth flow below (already hardcoded in the edge functions):

```
https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/google-oauth-callback
https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/tiktok-oauth-callback
```

## Secrets cheat-sheet

| Secret | Where it goes | Used by |
|--------|---------------|---------|
| `GOOGLE_CLIENT_ID` | GitHub repo secrets **and** Supabase edge-function secrets | Google OAuth (Ads + GA4), nightly token refresh |
| `GOOGLE_CLIENT_SECRET` | GitHub repo secrets **and** Supabase edge-function secrets | same |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | GitHub repo secrets **and** Supabase edge-function secrets | Google Ads API calls |
| `TIKTOK_APP_ID` | Supabase edge-function secrets only | TikTok OAuth |
| `TIKTOK_APP_SECRET` | Supabase edge-function secrets only | TikTok OAuth |
| Meta System User token | Nowhere — pasted per-connection in `/v2/integrations.html` | Meta insights sync |

GitHub repo secrets: repo → Settings → Secrets and variables → Actions.
Supabase edge-function secrets: Dashboard → Edge Functions → Secrets (or `supabase secrets set`).

## Google (covers both Google Ads and GA4)

1. **Google Cloud Console** (console.cloud.google.com), any project you control:
   - APIs & Services → Enable APIs: enable **Google Ads API**, **Google Analytics Data API**, and **Google Analytics Admin API**.
   - APIs & Services → OAuth consent screen: External, publish it (or add the connecting Google account as a test user). Scopes: `.../auth/adwords`, `.../auth/analytics.readonly`.
   - APIs & Services → Credentials → Create credentials → **OAuth client ID** → Web application. Authorized redirect URI: the `google-oauth-callback` URL above. Copy the client ID + secret → set as secrets per the table.
2. **Google Ads developer token** (Ads only, not needed for GA4):
   - ads.google.com → the **manager (MCC) account** → Admin → API Center → apply for a developer token.
   - A fresh token starts at "Test account only" access — apply for **Basic access** (form in API Center; approval usually days). Until Basic is granted, API calls against production accounts fail.
   - Set as `GOOGLE_ADS_DEVELOPER_TOKEN` per the table.
3. **Connect in SILO**: `/v2/integrations.html` → *Connect Google Ads* / *Connect GA4* (two separate connections, one consent each). After the redirect back, click **Test** — with no account ID set it lists accessible customer IDs / GA4 properties; paste the right one into the account field, Test again, then enable nightly sync.
   - If Baseballism's Ads account is under an MCC, put the MCC ID in `google_login_customer_id` (SQL or ask a dev) — the UI field holds the client customer ID.

## Meta Ads

No OAuth flow — Meta's recommended server-to-server credential is a **System User token**, which never expires.

1. **business.facebook.com** → Business settings → Users → **System users** → Add (Admin system user is fine).
2. Assign assets: give the system user access to the ad account(s) (read is enough).
3. Generate token: pick your app (create a Business-type app at developers.facebook.com if you have none), scopes `ads_read` + `business_management`, expiry **never**.
4. **Connect in SILO**: `/v2/integrations.html` → *Add Meta Ads token…* → paste the token (ad account ID optional — Test lists the accounts the token can see, e.g. `act_1234567890`). Test, set the account, enable sync.

## TikTok Ads

1. **business-api.tiktok.com** (TikTok for Business developer portal) → Become a developer → Create app.
   - Redirect URL: the `tiktok-oauth-callback` URL above.
   - Scopes: Ad Account Management (read) + Reporting.
   - Submit for approval (usually ~1–2 business days).
2. Copy the **App ID** and **Secret** → set `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` as Supabase edge-function secrets.
3. **Connect in SILO**: `/v2/integrations.html` → *Connect TikTok Ads* → authorize with the account that manages the advertiser. The callback captures the authorized advertiser IDs automatically (first one becomes the connection's advertiser ID — change it in the account field if needed). Test, enable sync.

## After connecting

- Deploy the new edge functions (merging the PR does NOT deploy):
  `google-oauth-start`, `google-oauth-callback`, `tiktok-oauth-start`,
  `tiktok-oauth-callback`, `test-ad-platform-connection`.
- Run the migration (`supabase/apply_all_post_merge.sql` or the single
  `20260807000000_ad_platform_direct_api.sql`), then `verify_v2_schema.sql` — all `ok`.
- First sync: Actions → **Ad Platforms KPI Sync** → Run workflow (optionally
  `days_back: 365` once for history, if the platform allows it — Meta caps insights
  at 37 months, TikTok reports at ~1 year, Google Ads/GA4 go further).
- Nightly thereafter at 10:30 UTC; results land in `marketing_kpis_daily` and
  surface on `/v2/marketing-overview.html`. Sync runs log to `sync_jobs`
  (`google_ads_kpis` / `meta_ads_kpis` / `tiktok_ads_kpis` / `ga4_kpis`).

## Token lifetimes / failure modes

| Platform | Credential | Lifetime | On failure |
|----------|-----------|----------|------------|
| Google Ads / GA4 | OAuth refresh token | Indefinite (revoked if unused ~6 months or password/permission change) | Sync errors `invalid_grant` → reconnect via Integrations |
| Meta Ads | System User token | Never expires | Only dies if the system user/app loses asset access → regenerate + re-paste |
| TikTok Ads | OAuth access token | Long-lived (v1.3 returns no expiry) | 401 from API → reconnect via Integrations |
