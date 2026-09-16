-- Correct what Ask SILO is told about Meta ad destinations.
--
-- The catalog sentence added by 20260915140000 encoded a guess that a live
-- sync then disproved. It still says:
--
--   "source effective_object_url may be the Facebook post rather than the
--    site, and 63% of this account's creatives are the page-post (SHARE) type
--    that relies on it"
--
-- Measured 2026-09-16, first run after the fetch was fixed:
--
--   [warn] Meta refused creative field effective_object_url per item
--   [meta] creative links: 82/126 resolved (asset_feed=82)
--
-- effective_object_url is REFUSED by this account as an unknown field and is
-- no longer requested at all, so no row can ever carry that source. And the
-- SHARE ads said to "rely on it" are the 82 that resolve through
-- asset_feed_spec -- every resolved ad in the window is object_type SHARE.
-- The sentence is wrong twice over and is exactly the kind of thing the model
-- repeats verbatim.
--
-- TARGETED REPLACE, not a rewritten description. A migration that rewrites
-- this column whole is how two Ask SILO caveats were silently dropped and had
-- to be restored in 20260910150000; only the wrong sentence goes. Idempotent:
-- the second run finds nothing to replace.
--
-- No refresh_chat_schema_catalog() call: this migration changes no table or
-- view, so the generated `columns` are already current, and the refresh would
-- only risk churn for nothing.
update public.silo_chat_schema_catalog
   set description = replace(
     description,
     'Read link_url_source before calling link_url a landing page -- source effective_object_url may be the Facebook post rather than the site, and 63% of this account''s creatives are the page-post (SHARE) type that relies on it.',
     'Read link_url_source before calling link_url a landing page: a resolved destination (asset_feed, object_url) is the creative''s on-file link rather than one the advertiser typed on the ad, and on a page-post ad Meta can in principle resolve one to the Facebook post -- measured 2026-09-16 none did, all were the site, so check the HOST rather than assuming either way. Coverage is PARTIAL by nature: 82 of 126 ads resolved in that window, every one via asset_feed and every one object_type SHARE; the rest (VIDEO and some SHARE) expose no destination field at all. link_url_tags was null on all 82 -- no UTMs on any ad -- so a null there is normal and is not evidence of a sync problem.')
 where relname = 'meta_ad_performance_v'
   and position('that relies on it' in coalesce(description, '')) > 0;
