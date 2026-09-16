-- Where a Meta ad actually sends the customer.
--
-- Asked for directly (Sammie, 2026-09-15): "Do you have destination link in
-- the Meta api? To see the landing page the ad is taking the customer too."
-- The answer was no. meta_ad_creatives carried the thumbnail, the copy, the
-- format and the status, and nothing about the destination -- so the Week
-- over Week creative table could show what an ad LOOKED like and never where
-- it pointed, and no query could line an ad up against
-- shopify_landing_pages_daily, which holds the sessions/cart/checkout funnel
-- for the very page that ad was feeding.
--
-- THE SHAPE OF THIS ACCOUNT DECIDED THE DESIGN. Stored creatives by
-- object_type, measured 2026-09-15:
--
--   SHARE                2,565 ads     PAGE      25
--   PHOTO                  930         POST_DELETED  15
--   VIDEO                  396         (null)     1
--   PRIVACY_CHECK_FAIL      83
--   STATUS                  64
--
-- 63% are SHARE -- an ad pointing at an EXISTING PAGE POST, which carries no
-- object_story_spec of its own. This is the same distribution that made the
-- copy work fail on its first attempt, and the same trap is here: resolving
-- the destination from object_story_spec alone would have covered about a
-- third of the account and rendered as "most of our ads go nowhere". So the
-- sync also asks for creative.effective_object_url, which is what those ads
-- have.
--
-- WHICH IS ALSO WHY link_url_source EXISTS AND IS NOT OPTIONAL. Meta may
-- resolve effective_object_url on a page-post ad to the POST rather than to
-- the advertiser's site. A link resolved that way is still the best answer
-- available for that ad, but it is a different KIND of answer from a
-- link_data URL the advertiser typed, and a column of bare URLs cannot be
-- told apart afterwards. Recording the source is what keeps the difference
-- legible -- and every reader shows the HOST, not just the path, so a
-- facebook.com destination is visibly a post and not a landing page.
--
-- No probe run stands behind these columns: the account's ad shapes are only
-- observable through a real sync, and a dispatchable probe workflow cannot be
-- run from an unmerged branch. The sync therefore MEASURES ITSELF -- it logs
-- resolved/total by source on every run -- and that log line, plus the
-- distribution of link_url_source after the first nightly, is the
-- verification. Treat coverage as unverified until then.

alter table public.meta_ad_creatives
  add column if not exists link_url text,
  add column if not exists link_url_source text,
  add column if not exists link_url_tags text;

-- The path, for joining an ad to the page it fed.
--
-- Generated rather than synced, for the same reason search_console_page_daily
-- generates page_path: the join to shopify_landing_pages_daily.landing_page_path
-- is the entire point, and a hand-maintained second copy of the same
-- derivation drifts from the URL it came from. Query and fragment are dropped
-- (a landing page is not a new page per utm_source); a bare origin becomes
-- '/'. Null when link_url is null or is not a parseable http(s) origin.
--
-- Note this deliberately keeps the path for a facebook.com destination too.
-- Filtering by host is the READER's decision and it needs the host to make
-- it; silently emptying the path for some destinations would make an absent
-- path mean two different things.
--
-- ADD IF NOT EXISTS, never drop-then-add. apply_all_post_merge.sql is
-- documented as safe to re-run, and meta_ad_performance_v selects this
-- column -- so a drop fails with "other objects depend on it" the second
-- time, taking the whole re-apply down with it. Caught by running this
-- migration twice in the database test rather than in production.
alter table public.meta_ad_creatives
  add column if not exists link_path text generated always as (
    case
      when link_url ~ '^https?://[^/?#]+' then
        coalesce(
          nullif(regexp_replace(regexp_replace(link_url, '^https?://[^/?#]+', ''), '[?#].*$', ''), ''),
          '/')
    end
  ) stored;

-- link_url and link_url_source are null or non-null TOGETHER.
--
-- Same stance as silo_chat_saved_reports.row_estimate / row_estimate_at: a
-- measurement with nothing saying how it was arrived at is not interpretable,
-- and here it is worse than uninterpretable -- an unattributed URL cannot be
-- told apart from a page-post URL standing in for a landing page. NOT VALID
-- is not used: the columns are new, so every existing row is (null, null) and
-- already satisfies it.
alter table public.meta_ad_creatives
  drop constraint if exists meta_ad_creatives_link_source_together;
alter table public.meta_ad_creatives
  add constraint meta_ad_creatives_link_source_together
  check ((link_url is null) = (link_url_source is null));

comment on column public.meta_ad_creatives.link_url is
  'Destination URL the ad sends a click to, resolved in order: object_story_spec link_data.link, video_data call-to-action link, link_data call-to-action link, first carousel card link, photo call-to-action link, asset_feed_spec link_urls, then creative.effective_object_url. http(s) only -- an app deep link or messenger thread is not a landing page and is stored as null. Null means no web destination was resolved, which on a SHARE ad may also mean Meta refused the link fields that run: check link_url_source and the sync log.';

comment on column public.meta_ad_creatives.link_url_source is
  'Which source produced link_url: link_data | video_cta | link_data_cta | carousel_card | photo_cta | asset_feed | effective_object_url. Null exactly when link_url is null. effective_object_url is the LAST resort and the one to read carefully -- on a page-post (SHARE) ad Meta may resolve it to the Facebook post rather than to the advertiser''s site, so a destination from that source is not automatically a landing page. 63% of this account''s creatives are SHARE.';

comment on column public.meta_ad_creatives.link_url_tags is
  'creative.url_tags as Meta stores it -- the UTM query string appended to the destination, unparsed. Deliberately not split into columns: it is free text and a canonical parse would bake one reading of it into the table.';

comment on column public.meta_ad_creatives.link_path is
  'Generated from link_url: path only, query and fragment dropped, bare origin as ''/''. Exists to join an ad to the page it fed -- shopify_landing_pages_daily.landing_page_path -- the same reason search_console_page_daily generates page_path. Keeps the path for facebook.com destinations too, so filtering by host stays the reader''s decision.';

-- ── Expose it where ads are already read ──────────────────────────────
-- APPENDED to the end of the select list, for the reason 20260902020000
-- wrote down: CREATE OR REPLACE VIEW can only add columns at the end, and
-- this view carries grants plus security_invoker = true that a DROP would
-- lose. Ordering is cosmetic; those are not.
--
-- The inline comments below are kept verbatim from that migration. A replace
-- that silently drops them is the same class of loss the daily drift check
-- caught in the Ask SILO catalog (restored in 20260910150000).
create or replace view public.meta_ad_performance_v
  with (security_invoker = true) as
 SELECT p.company_entity_id,
    p.day_date,
    p.account_id,
    p.campaign_id,
    p.campaign_name,
    p.adset_id,
    p.adset_name,
    p.ad_id,
    p.ad_name,
    p.impressions,
    p.clicks,
    p.spend,
    p.conversions,
    p.conversion_value,
    p.view_content,
    p.add_to_cart,
    p.initiate_checkout,
    c.thumbnail_url,
    c.title AS creative_title,
    c.body AS creative_body,
    c.object_type AS creative_type,
    c.effective_status,
    -- NULL here means "not reported", never zero: a video buy has no leads and
    -- a lead buy has no thruplays, and a 0 would rank an ad worst on a metric
    -- it was never bought on.
    p.thruplays,
    p.leads,
    -- Which of creative.body / object_story_spec / the page post produced
    -- creative_body above. Null means no copy was found on any of them --
    -- worth having beside the copy so an empty cell is legible.
    c.body_source AS creative_body_source,
    -- Where the ad SENDS the click. link_url_source is not decoration: read
    -- it before calling link_url a landing page, because on a page-post
    -- (SHARE) ad the last-resort source is the creative's resolved
    -- destination and Meta may resolve that to the post itself.
    c.link_url,
    c.link_url_source,
    c.link_url_tags,
    -- Path only, for joining to shopify_landing_pages_daily.landing_page_path.
    c.link_path
   FROM meta_ad_performance_daily p
     LEFT JOIN meta_ad_creatives c ON c.ad_id = p.ad_id AND c.company_entity_id = p.company_entity_id;

comment on view public.meta_ad_performance_v is
  'Ad-level Meta performance joined to its creative. thruplays/leads are NULL when the ad did not report the metric, never 0. creative_body_source says which of creative.body, object_story_spec or the page post produced the copy. link_url is where the ad sends a click and link_path is its path, for joining to shopify_landing_pages_daily.landing_page_path; read link_url_source first, since the effective_object_url source may be the Facebook post rather than the advertiser''s site, and a null link_url means "not resolved", never "no destination". SECURITY INVOKER so the base tables'' company RLS still applies.';

-- ── Teach Ask SILO ────────────────────────────────────────────────────
-- APPENDED, not replaced. A migration that rewrote this description whole
-- is how two catalog caveats were silently dropped and had to be restored
-- in 20260910150000; the same mistake here would discard the coverage
-- caveat above.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog
   set description = coalesce(description, '')
     || ' Also carries each ad''s DESTINATION: link_url (where the click goes), link_path'
     || ' (path only, for joining to shopify_landing_pages_daily.landing_page_path),'
     || ' link_url_tags (the raw UTM string) and link_url_source. Read link_url_source'
     || ' before calling link_url a landing page -- source effective_object_url may be the'
     || ' Facebook post rather than the site, and 63% of this account''s creatives are the'
     || ' page-post (SHARE) type that relies on it. A null link_url is "not resolved",'
     || ' never "this ad has no destination".',
       keywords = array(select distinct unnest(
         coalesce(keywords, array[]::text[])
         || array['destination','landing page','link','url','where does the ad go','utm','click destination']))
 where relname = 'meta_ad_performance_v'
   and coalesce(description, '') not like '%link_url_source%';
