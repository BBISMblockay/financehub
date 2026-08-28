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

**Replacing a regenerated token — do NOT use *Add Meta Ads token…* for this.** That button
only ever INSERTs, so pasting a refreshed token there creates a SECOND connection for the
same ad account. Use **Replace token** on the existing row instead: it swaps the credential
in place and clears the row's previous test result, since the old "OK" pill was earned by
the old token. The add form now refuses an account that is already connected (comparing
`act_51281951` and `51281951` as the same account) and points here.

For the record, a duplicate connection would NOT have doubled spend: every Meta table
upserts on an identity hash that deliberately excludes `connection_id` — `marketing_kpis_daily`
on company+platform+account+campaign+day, `meta_ad_performance_daily` on
company+account+ad+day, `meta_ad_creatives` and `instagram_media_insights` on their natural
keys — and the account id in those hashes comes from Meta's API response, not from the
field you typed. Two connections on one account would land on the same rows and overwrite.
What it WOULD cost is a doubled nightly pull against an account that already hits
"Application request limit reached", a `connection_id` that flips between rows, and a
stale-token row failing the whole workflow. Genuine double-counting needs two connections
pointing at two DIFFERENT account ids.

### Optional: organic Instagram + Facebook Page insights (posts/reels — separate from the ads pull above)

The System User token above only grants `ads_read` — organic reach/engagement needs two additional things, not just a permission checkbox:

1. **Add scopes to the same token**: regenerate it (step 3 above) with `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights` added alongside `ads_read` + `business_management`.
2. **Assign the System User to the Page**: Business settings → Users → System Users → your system user → **Assign Assets** → Pages → select the Baseballism Page, grant at least Analyst access. Token scopes alone don't grant Page access — this asset assignment is separate and easy to miss.
3. The Instagram professional account must already be **linked to that Facebook Page** (Instagram app → Settings → linked accounts) — this is how Meta's API finds the Instagram business account ID from the Page.
4. Send Blake the **Facebook Page ID** and **Instagram Business Account ID** (Graph API Explorer: `GET /me/accounts` for the Page ID, then `GET /{page-id}?fields=instagram_business_account` for the IG account ID) — set on the existing Meta connection row (`facebook_page_id`, `instagram_business_account_id`), no new connection needed.

Note: Meta unified impression-style metrics on Instagram media insights into a single `views` metric in 2024 — if comparing against an older report that says "impressions," that's the same thing under the new name.

**Page Insights needs a PAGE access token, not the System User token.** The ads pull and
Instagram both authenticate fine with the System User token, but `/{page-id}/insights`
answers `(#190) This method must be called with a Page Access Token`. The sync now derives
one automatically by reading `access_token` off the Page node before each Page pull, so
there is nothing extra to paste — but that exchange only succeeds while the System User has
the Page **assigned as an asset** (step 2 above). If the log says "Could not derive a Page
access token", that assignment is what is missing; it is not a token or metric problem.
This is also why Instagram was writing 50 rows in the very same run where Page insights
wrote none — different auth path, not a different failure.

**Page metrics are on a moving deprecation schedule, Instagram's are not.** Meta retires
Page Insights metrics globally -- for ALL API versions at once, retroactively -- so pinning
`META_API_VERSION` does not hold them still, and there is no permission, token or access
tier that brings a retired metric back. It is deleted, not withheld. Do not confuse this
with `(#190) must be called with a Page Access Token`, which IS an access problem and is
handled above; both errors were hit on 2026-08-28 and only one of them was fixable.

The API rejects a retired name with `(#100) The value must be a valid insights metric` and
does **not** say which name it objected to, so one dead metric in a combined request kills
every metric in it. `fetchFacebookPageInsights` therefore falls back to requesting each
metric on its own when it sees that error, keeps whatever still works, and reports the rest
as `page_metrics_dropped` in the `sync_jobs` result.

What we request now, and why, from Meta's own deprecation table:

| Metric | Status | What we use |
|--------|--------|-------------|
| `page_impressions` | retired 2025-11-15 | `page_media_view` |
| `page_impressions_unique` | retired 2025-06-15 | `page_total_media_view_unique` |
| `page_engaged_users` | retired 2024-03-14 | **nothing** -- no replacement exists |
| `page_post_engagements` | still served | unchanged |

**A media view is not an impression, and a unique media view is not reach.** These are
related but different measurements, so they begin a NEW series rather than continuing the
old one -- never splice them onto historical impression/reach numbers from Business Suite
or an old report. `page_engaged_users` has no successor at all: its column stays null and
is omitted from the row payload rather than written as 0, because "Meta stopped measuring
this" is not zero.

**Backfilling history — the two halves work differently, and `days_back` only drives one.**

*Facebook Page* history is date-windowed, so `days_back` reaches further back (Meta retains
roughly two years). The window is chunked at 90 days per request and each chunk follows
`paging.next`. Both matter only for long windows, which is why their absence went unnoticed
at 30 days: a single un-paged request returns just the first page, so a year-long window
would have come back QUIETLY TRUNCATED, with fewer days than asked for and no error.

Page Insights `paging.next` walks the time window **forward** rather than ending at the
`until` that was asked for, so following it blindly marches past the window into buckets
that have not happened yet. Doing exactly that on 2026-08-28 wrote 90 future-dated rows
(08-29..11-26) full of ZEROES — worse than missing data, because a zero reads as a measured
value and would have dragged every average down while the UI's null-check happily rendered
it. The fetcher now stops paging as soon as a page reaches past the chunk end, and
separately keeps only days inside `[startDate, endDate)`. The upper bound is exclusive
because `endDate` is today and today is still in progress, so that range is exactly the set
of COMPLETE days. Both guards are deliberate: the clamp filters by DATE and never by value,
so a genuine zero-engagement day inside the window is still kept.

*Instagram* history is **not** date-windowed at all — media insights are lifetime cumulative
counters with no date range, so reaching further back means walking through more POSTS.
`days_back` has no effect on Instagram whatsoever. Use the `ig_post_limit` workflow input
(`ADS_IG_POST_LIMIT`) instead; it defaults to 50, which is the nightly's deliberate cost
ceiling, since every post costs its own extra insights request against a rate limit this
account already trips. The walk stops mid-page once the cap is reached rather than finishing
the page, and the run logs a note when it stops exactly on the cap so a truncated walk is
not mistaken for complete history.

One-off backfill, via **Actions → Ad Platforms KPI Sync → Run workflow**:

    platform:      meta_ads
    connection_id: <the meta_ads connection id>
    days_back:     365      # Facebook Page days
    ig_post_limit: 500      # Instagram posts

Every write is an idempotent upsert on identity, so a backfill can be re-run safely and the
nightly 30-day window afterwards refreshes recent rows without disturbing the older ones it
no longer covers.

`page_fan_count` is unaffected by all of this -- it comes from the Page node
(`?fields=fan_count`), not the insights edge. (The `page_fans` INSIGHTS metric was retired
2025-11-15 with `page_follows` as its alternative; we do not use it.)

When a future round retires something else, `page_metrics_dropped` names it. Look it up in
Meta's deprecation table and swap the alternative into `PAGE_INSIGHT_METRICS`, which maps
metric name to output field in one place. The Marketing Organic tab hides a column that is
null across the whole window and names it in the note, so a newly-retired metric degrades
to a hidden column rather than a wall of zeroes.

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
| Meta Ads | System User token | Never expires | Only dies if the system user/app loses asset access → regenerate, then **Replace token** on the existing row (see below) |
| TikTok Ads | OAuth access token | Long-lived (v1.3 returns no expiry) | 401 from API → reconnect via Integrations |
