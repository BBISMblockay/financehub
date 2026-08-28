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

### Optional: organic Instagram + Facebook Page insights (posts/reels — separate from the ads pull above)

The System User token above only grants `ads_read` — organic reach/engagement needs two additional things, not just a permission checkbox:

1. **Add scopes to the same token**: regenerate it (step 3 above) with `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights` added alongside `ads_read` + `business_management`.
2. **Assign the System User to the Page**: Business settings → Users → System Users → your system user → **Assign Assets** → Pages → select the Baseballism Page, grant at least Analyst access. Token scopes alone don't grant Page access — this asset assignment is separate and easy to miss.
3. The Instagram professional account must already be **linked to that Facebook Page** (Instagram app → Settings → linked accounts) — this is how Meta's API finds the Instagram business account ID from the Page.
4. Send Blake the **Facebook Page ID** and **Instagram Business Account ID** (Graph API Explorer: `GET /me/accounts` for the Page ID, then `GET /{page-id}?fields=instagram_business_account` for the IG account ID) — set on the existing Meta connection row (`facebook_page_id`, `instagram_business_account_id`), no new connection needed.

Note: Meta unified impression-style metrics on Instagram media insights into a single `views` metric in 2024 — if comparing against an older report that says "impressions," that's the same thing under the new name.

**Page metrics are on a moving deprecation schedule, Instagram's are not.** Meta has been
retiring Page Insights metrics — the Nov 2025 round took `impressions`/`page fans`, the
June 15 2026 round took the unique reach/impressions family — and these retirements are
GLOBAL, not per-version, so pinning `META_API_VERSION` does not hold them still. The API
rejects a retired name with `(#100) The value must be a valid insights metric` and does
**not** say which name it objected to, so one dead metric in a combined request kills every
Page metric in it. That is what happened on 2026-08-28, the first run after
`facebook_page_id` was set: Page insights wrote 0 rows while Instagram, in the same run,
wrote 50.

`fetchFacebookPageInsights` therefore falls back to requesting each metric on its own when
it sees that specific error, keeps whatever still works, and reports the rest as
`page_metrics_dropped` in the `sync_jobs` result. **Read that field rather than assuming a
metric is populated** — the sync no longer fails when Meta retires one, which means a
column can quietly go all-null. When it names a metric, pick the current replacement from
Meta's deprecation page and swap it in `PAGE_INSIGHT_METRICS`.

The Instagram and Facebook halves are also independently error-trapped: a Page failure
records `page_error` and leaves `media_upserted` intact, instead of replacing the whole
organic summary with an error string (which is what hid those 50 Instagram rows).

`page_fan_count` comes from the Page node (`?fields=fan_count`), not the insights edge —
which is why the column sat unwritten from the table's creation until 2026-08-28. It is a
current snapshot, so only the newest day is stamped, by a targeted update after the main
upsert; the trailing-window upsert deliberately omits the column so it cannot blank out
days an earlier run already stamped. Older days stay null — a follower count cannot be
honestly backfilled.

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
