-- Expose thruplays, leads and the copy's provenance on meta_ad_performance_v.
--
-- The columns landed on meta_ad_performance_daily (20260902010000) and
-- meta_ad_creatives (20260902000000), but this view lists its columns
-- explicitly, so ad-hoc queries and Ask SILO reading THROUGH the view could
-- not see them -- while the report, which reads the base tables via
-- wow_creatives, could. A view that silently exposes less than the table it
-- wraps is how two people run "the same" query and get different answers.
--
-- APPENDED, NOT INSERTED. CREATE OR REPLACE VIEW can only add columns to the
-- END of the list; slotting thruplays next to initiate_checkout where it
-- belongs semantically would force a DROP, and this view carries grants to
-- anon/authenticated plus security_invoker = true. Losing either to tidy the
-- column order would be a bad trade -- the ordering is cosmetic, the grants
-- and RLS propagation are not.
--
-- security_invoker stays true: the underlying tables are RLS-scoped by
-- company, and this view must keep inheriting that rather than reading as its
-- owner.
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
    c.body_source AS creative_body_source
   FROM meta_ad_performance_daily p
     LEFT JOIN meta_ad_creatives c ON c.ad_id = p.ad_id AND c.company_entity_id = p.company_entity_id;

comment on view public.meta_ad_performance_v is
  'Ad-level Meta performance joined to its creative. thruplays/leads are NULL when the ad did not report the metric, never 0. creative_body_source says which of creative.body, object_story_spec or the page post produced the copy. SECURITY INVOKER so the base tables'' company RLS still applies.';
