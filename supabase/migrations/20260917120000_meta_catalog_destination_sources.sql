-- The destination sources a catalog ad actually uses.
--
-- MEASURED, by scripts/meta-creative-probe.mjs on 2026-09-17, over the 14
-- highest-spend ads that had resolved no destination ($2,025,098 of a
-- $2,346,434 block): 14 of 14 HAD one. The resolver was reading link_data /
-- video_data / photo_data, and a catalog ad keeps its link in
-- object_story_spec.template_data. Those ads were never refused and were never
-- destination-less -- nothing was looking in the right place.
--
-- Three source names are added: template_data (10 of the 14), template_card
-- (its per-card carousel links, 2), and page_post (the remaining 4, whose
-- object_story_spec is empty and whose only destination is on the page post
-- the sync now fetches when the LINK is missing, not only when the copy is).
--
-- Two things these comments claimed that are wrong, and go:
--   * effective_object_url is listed as a source. This account REFUSES that
--     field as unknown, so it is not requested and no row can carry it. The
--     Ask SILO catalog said the same and was corrected in 20260916030000;
--     these column comments were missed.
--   * "a destination from that source may be the Facebook post rather than the
--     site" was attached to effective_object_url. That caution was right and
--     belonged to a source that never existed; page_post is the one it is
--     genuinely about, so it moves there rather than being dropped.
--
-- Comments only. No table, view, function, policy or data change.

comment on column public.meta_ad_creatives.link_url is
  'Destination URL the ad sends a click to, resolved in order: object_story_spec link_data.link, template_data.link (catalog / Dynamic Product Ads), video_data call-to-action link, link_data call-to-action link, first carousel card link, first template child card link, photo call-to-action link, asset_feed_spec link_urls, creative.object_url, then the page post''s attachment. http(s) only -- an app deep link or messenger thread is not a landing page and is stored as null. A Facebook l.facebook.com SHIM is also refused: the post''s url/target.url wrap the real destination in a redirector, so only the attachment''s unshimmed_url is read. Null means no web destination was resolved, which can also mean Meta refused the link fields that run: check link_url_source and the sync log line.';

comment on column public.meta_ad_creatives.link_url_source is
  'Which source produced link_url: link_data | template_data | video_cta | link_data_cta | carousel_card | template_card | photo_cta | asset_feed | object_url | page_post. Null exactly when link_url is null. page_post is the one to read carefully -- it is the destination on the PAGE POST rather than on the ad, so a reader should show the HOST rather than assume the advertiser''s own site (it is the unshimmed target, so in practice it has been). template_data is the catalog-ad case and is an ordinary landing page. effective_object_url was listed here and is NOT a source: this account refuses that field as unknown, so it is never requested and no row can carry it.';

-- ── Ask SILO's catalog, which still repeats what the probe disproved ───────
--
-- 20260916030000 wrote a coverage caveat onto meta_ad_performance_v's catalog
-- description. That text is injected into Ask SILO's prompt VERBATIM, and four
-- of its claims are now measurably false:
--
--   "82 of 126 ads resolved in that window"      -- 2,468 of 4,079 by 2026-09-17
--   "every one via asset_feed"                   -- asset_feed, link_data,
--                                                   video_cta, carousel_card
--   "the rest (VIDEO and some SHARE) expose no
--    destination field at all"                   -- DISPROVED: the probe found
--                                                   14 of 14 such ads HAD one
--   "link_url_tags was null on all 82 -- no
--    UTMs on any ad"                             -- 759 ads carry UTMs
--
-- The third is the one that matters most: it is a claim about what an ad type
-- CAN have, inferred from one 126-ad window, and Ask SILO would repeat it to
-- someone asking why catalog ads have no landing page. It is exactly the
-- inference this PR's probe was written to test, and it failed.
--
-- The replacement deliberately carries NO coverage COUNT. A count is what rots
-- -- 82 of 126 was true for about a day -- and the durable facts are
-- structural: which sources exist, what a null means, and what bounds coverage.
-- Anyone who wants the number can count the column.
--
-- TARGETED REPLACE of that one block, never a rewritten description: rewriting
-- this column whole is how two caveats were silently dropped and had to be
-- restored in 20260910150000. Idempotent -- the second run finds nothing.
--
-- It NO-OPS SILENTLY if production's text has drifted, so verify_v2_schema.sql
-- asserts the OUTCOME ("Ask SILO ad destination coverage claim") rather than
-- trusting this update, the same stance 20260916030000 established.

update public.silo_chat_schema_catalog
   set description = replace(
     description,
     'Read link_url_source before calling link_url a landing page: a resolved destination (asset_feed, object_url) is the creative''s on-file link rather than one the advertiser typed on the ad, and on a page-post ad Meta can in principle resolve one to the Facebook post -- measured 2026-09-16 none did, all were the site, so check the HOST rather than assuming either way. Coverage is PARTIAL by nature: 82 of 126 ads resolved in that window, every one via asset_feed and every one object_type SHARE; the rest (VIDEO and some SHARE) expose no destination field at all. link_url_tags was null on all 82 -- no UTMs on any ad -- so a null there is normal and is not evidence of a sync problem.',
     'Read link_url_source before calling link_url a landing page. It names where the destination came from: link_data or template_data (the advertiser''s own link -- template_data is the catalog / Dynamic Product Ad case and is an ordinary collection page), video_cta, link_data_cta, carousel_card, template_card, photo_cta, asset_feed, object_url, or page_post. page_post is the one to read carefully: it is the destination on the PAGE POST rather than on the ad, so show the HOST rather than assuming the advertiser''s own site. A NULL link_url means NOT RESOLVED -- never "this ad has no destination", and never "ads of this type have none". That second inference was made from one 126-ad window and DISPROVED on 2026-09-17: 14 of 14 sampled ads that had resolved nothing did have a destination, in template_data or on the page post. Coverage is bounded by which ads have been ASKED about, not by what Meta will answer: the nightly requests creatives only for ads inside its trailing window, and scripts/meta-creative-backfill.mjs reaches the rest. link_url_tags (the UTM string) is present on some ads and absent on others, so a null there is not evidence of a sync problem in either direction -- count the column rather than assuming.')
 where relname = 'meta_ad_performance_v'
   and position('expose no destination field at all' in coalesce(description, '')) > 0;
