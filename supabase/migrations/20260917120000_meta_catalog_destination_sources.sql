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
