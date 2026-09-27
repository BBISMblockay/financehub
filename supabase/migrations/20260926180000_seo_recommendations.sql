-- ─────────────────────────────────────────────────────────────────────────────
-- SEO recommendations: one evidenced, ranked, reviewable list over data that
-- already exists (SERP observations, Search Console, competitor page-type and
-- on-page captures). Nothing wrote a recommendation before this migration;
-- seo_tasks existed with no writer surface at all.
--
-- ONE VIEW, read by BOTH the page (supabase-js, caller's RLS) and Ask SILO
-- (chat_run_readonly_query, SECURITY INVOKER, 8s authenticated timeout in
-- practice). It reads ONLY other views/rollups that are already cheap and
-- company-scoped: seo_keyword_landscape_v, seo_serp_features_v,
-- seo_serp_observations (for the exact competitor observation row),
-- seo_competitor_page_inspections, page_inspections and
-- search_console_query_rollup_v (the 90-day matview wrapper -- NEVER
-- search_console_query_daily/search_console_page_daily directly, which
-- CLAUDE.md documents at ~405k rows and measured 27.9s at click time).
--
-- SIX OPPORTUNITY CLASSES, each a row (or, for missing_category, a cluster of
-- keywords) in the union:
--   a. page_one_not_top3    -- our_serp_position 4-10, with impressions
--   b. absent_with_demand   -- a run happened, we are not in it, SC shows
--                              demand. "check, one snapshot" until 2 runs agree
--   c. page_two             -- our_serp_position 11-20
--   d. missing_category     -- a cluster of active keywords sharing a stem,
--                              with demand, none ever ranked
--   e. content_brief        -- a competitor ranks with an ARTICLE where we
--                              rank with a collection/home page or don't rank;
--                              People Also Ask questions as the outline
--   f. defend               -- top-3 with meaningful clicks, flagged when
--                              movement is negative
--
-- ABSENCE IS NEVER ZERO, same rule as the rest of this module: our_position,
-- competitor fields and the captures are all NULL when not observed/captured,
-- never a synthesized zero or empty string.
--
-- EVIDENCE STRENGTH is exactly 'strong' / 'moderate' / 'early' -- never a
-- percentage or a numeric confidence. Rule (documented once, matched by the
-- page's table foot in v2/seo-keywords.html):
--   early    -- resting on a single SERP run (observation_runs < 2), or (for
--               missing_category, which has no SERP run at all) no clicks yet
--   strong   -- 2+ runs AND nonzero clicks (28d for the SERP classes)
--   moderate -- everything else that qualified for a class
--
-- SCORE (identical wording lives in the table foot of v2/seo-keywords.html --
-- one definition of the number, per CLAUDE.md's own stated pattern):
--   score = Search Console impressions (28d) x rank-gap-to-target, halved
--   when the opportunity rests on a single SERP run (observation_runs < 2).
--   Target is #3 for page_one_not_top3 and content_brief rows ranked <=10,
--   #10 for page_two and content_brief rows ranked >10. defend's gap is
--   (4 - our_position): defending #1 protects more click volume than
--   defending #3, so it is NOT "already at target, no gap" -- it is scored on
--   how much there is to lose. absent_with_demand and missing_category have
--   no current rank, so they score on impressions alone (gap = 1);
--   missing_category's "impressions (28d)" is the cluster's combined 90-day
--   Search Console total (search_console_query_rollup_v's own window), the
--   only demand figure a never-ranking cluster can have.
--
-- CLASS f's MOVEMENT WORDING: seo_keyword_landscape_v tracks only the latest
-- and the ONE previous completed run per identity, so this view can never
-- honestly say "3+ runs show a consistent direction" -- doing so would need a
-- window over raw observations this view does not read. It always reads as
-- "the transition between the two most recent runs, not a trend" -- a
-- deliberately conservative subset of the requested behaviour: never
-- overclaiming a trend beats inventing one from two points.
--
-- STEMMING (missing_category): lowercase, strip punctuation, drop a fixed
-- stopword list, take the FIRST 1-2 remaining significant words, strip a
-- trailing 's' from each. "Baseball dad hats" -> "baseball dad" (2 sig.
-- words) -> stem "baseball dad", NOT "hat" -- this is a literal reading of
-- "first 1-2 significant words", so a cluster groups keywords that share an
-- OPENING phrase, not every keyword containing a shared noun ("dad hats" and
-- "baseball hats" do NOT cluster under this method). Documented rather than
-- hidden: a simple stem is what was asked for, and this is the simple choice.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The stem, as its own IMMUTABLE function (testable in isolation) ─────────
create or replace function public.seo_recommendations_keyword_stem(p_keyword text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select coalesce(string_agg(regexp_replace(w, 's$', ''), ' ' order by ord), '')
  from (
    select w, ord
    from unnest(
      regexp_split_to_array(
        lower(btrim(regexp_replace(p_keyword, '[^a-zA-Z0-9\s]', ' ', 'g'))),
        '\s+'
      )
    ) with ordinality as t(w, ord)
    where w <> ''
      and w not in ('a','an','the','for','and','or','of','to','in','on','with','by','my','your','our')
    order by ord
    limit 2
  ) s
$$;

comment on function public.seo_recommendations_keyword_stem(text) is
  'A deliberately simple category key for seo_recommendations_v''s missing_category '
  'class: lowercase, strip punctuation, drop a fixed stopword list, take the '
  'first 1-2 remaining significant words, strip a trailing s from each. Groups '
  'keywords sharing an opening phrase, not every keyword sharing a noun -- '
  '"baseball dad hats" and "kids baseball hats" do not share a stem under this '
  'method. IMMUTABLE and unit-tested in isolation.';

-- ── The recommendations view ─────────────────────────────────────────────────
drop view if exists public.seo_recommendations_v;
create view public.seo_recommendations_v
with (security_invoker = true) as
with base as (
  -- One row per (active keyword, run identity) the keyword landscape already
  -- computes, with the best-ranked COMPETITOR result (above us, or #1 if we
  -- are absent) and our own result pulled out of the same jsonb the landscape
  -- already built -- no re-reading of raw observations for that part.
  select
    l.company_entity_id,
    l.keyword_id,
    l.keyword,
    l.provider,
    l.device,
    l.location_name,
    l.our_serp_position,
    l.observation_runs,
    l.results_in_latest_run,
    l.latest_run_id,
    l.latest_observed_on,
    l.our_serp_movement,
    l.search_console_avg_position_28d,
    coalesce(l.search_console_clicks_28d, 0)::bigint      as sc_clicks_28d,
    coalesce(l.search_console_impressions_28d, 0)::bigint as sc_impressions_28d,
    own.url                                                as our_url,
    comp.url                                               as competitor_url,
    comp.domain                                            as competitor_domain,
    comp.position                                          as competitor_position,
    case when own.url is not null then public.seo_serp_page_type(own.url) end as our_page_type,
    case when comp.url is not null then public.seo_serp_page_type(comp.url) end as competitor_page_type,
    own_cap.title                                          as our_captured_title,
    own_cap.h1                                             as our_captured_h1,
    comp_cap.title                                         as competitor_captured_title,
    comp_cap.h1                                            as competitor_captured_h1
  from public.seo_keyword_landscape_v l
  left join lateral (
    select (r ->> 'url') as url
    from jsonb_array_elements(coalesce(l.latest_top_results, '[]'::jsonb)) r
    where coalesce((r ->> 'is_own_domain')::boolean, false) and r ->> 'result_type' = 'organic'
    order by (r ->> 'position')::int
    limit 1
  ) own on true
  left join lateral (
    select (r ->> 'url') as url, (r ->> 'domain') as domain, (r ->> 'position')::int as position
    from jsonb_array_elements(coalesce(l.latest_top_results, '[]'::jsonb)) r
    where not coalesce((r ->> 'is_own_domain')::boolean, false) and r ->> 'result_type' = 'organic'
      and (l.our_serp_position is null or (r ->> 'position')::int < l.our_serp_position)
    order by (r ->> 'position')::int
    limit 1
  ) comp on true
  left join lateral (
    select p.title, p.h1
    from public.page_inspections p
    where p.company_entity_id = l.company_entity_id and p.requested_url = own.url
    order by p.fetched_at desc
    limit 1
  ) own_cap on own.url is not null
  left join lateral (
    select ci.title, ci.h1
    from public.seo_serp_observations o
    join public.seo_competitor_page_inspections ci on ci.observation_id = o.id
    where o.run_id = l.latest_run_id and o.keyword_id = l.keyword_id
      and o.result_type = 'organic' and o.position = comp.position
    order by ci.fetched_at desc
    limit 1
  ) comp_cap on comp.url is not null
  where l.is_active
),
paa as (
  -- People Also Ask questions per (run, keyword), the outline for class e.
  select f.run_id, f.keyword_id, jsonb_agg(distinct e ->> 'title') as questions
  from public.seo_serp_features_v f
  cross join lateral jsonb_array_elements(coalesce(f.details -> 'entries', '[]'::jsonb)) e
  where f.feature_type = 'people_also_ask' and nullif(e ->> 'title', '') is not null
  group by f.run_id, f.keyword_id
),
-- ── Class d: missing_category, computed once over the whole active set ──────
cluster_keywords as (
  select k.company_entity_id, k.id as keyword_id, k.keyword, k.keyword_norm,
         public.seo_recommendations_keyword_stem(k.keyword) as stem
  from public.seo_keyword_set k
  where k.is_active and public.seo_recommendations_keyword_stem(k.keyword) <> ''
),
cluster_rank_evidence as (
  select l.keyword_id,
         bool_or(l.our_serp_position is not null or l.our_previous_serp_position is not null) as ever_ranked
  from public.seo_keyword_landscape_v l
  group by l.keyword_id
),
cluster_demand as (
  select ck.company_entity_id, ck.stem,
         count(distinct ck.keyword_id)                    as keyword_count,
         array_agg(distinct ck.keyword order by ck.keyword) as keywords,
         sum(coalesce(r.clicks, 0))::bigint                as clicks,
         sum(coalesce(r.impressions, 0))::bigint           as impressions
  from cluster_keywords ck
  left join public.search_console_query_rollup_v r
    on r.company_entity_id = ck.company_entity_id and r.keyword_norm = ck.keyword_norm
  group by ck.company_entity_id, ck.stem
),
cluster_final as (
  select cd.*
  from cluster_demand cd
  where cd.keyword_count >= 2
    and (cd.clicks > 0 or cd.impressions > 0)
    and not exists (
      select 1
      from cluster_keywords ck2
      join cluster_rank_evidence re on re.keyword_id = ck2.keyword_id
      where ck2.company_entity_id = cd.company_entity_id and ck2.stem = cd.stem and re.ever_ranked
    )
),
unioned as (
  -- a. page_one_not_top3 -- rank 4-10, with impressions.
  select
    b.company_entity_id, 'page_one_not_top3'::text as opportunity_class, 'Page one, not top 3'::text as class_label,
    b.keyword_id, b.keyword, null::text[] as keyword_cluster,
    b.provider, b.device, b.location_name,
    b.our_serp_position as our_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    null::jsonb as paa_questions,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement as movement,
    null::boolean as is_at_risk,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      b.sc_impressions_28d::numeric * greatest(b.our_serp_position - 3, 1)
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when b.sc_clicks_28d > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('We rank #%s on %s for "%s" (%s Search Console impressions, 28d).%s',
      b.our_serp_position, b.device, b.keyword, b.sc_impressions_28d,
      case when b.competitor_domain is not null
        then format(' %s ranks #%s with a %s page.', b.competitor_domain, b.competitor_position, coalesce(b.competitor_page_type, 'unclassified'))
        else '' end
    ) as suggested_action
  from base b
  where b.our_serp_position between 4 and 10
    and b.sc_impressions_28d > 0

  union all

  -- b. absent_with_demand -- a run happened, we are not in it, SC shows demand.
  select
    b.company_entity_id, 'absent_with_demand', 'Absent with demand',
    b.keyword_id, b.keyword, null::text[],
    b.provider, b.device, b.location_name,
    b.our_serp_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    null::jsonb,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement,
    null::boolean,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      b.sc_impressions_28d::numeric
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when b.sc_clicks_28d > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('Search Console recorded %s impressions and %s clicks (28d) for "%s", but the latest %s run did not find our storefront in the observed results.%s%s',
      b.sc_impressions_28d, b.sc_clicks_28d, b.keyword, b.device,
      case when b.observation_runs is not null and b.observation_runs < 2
        then ' This is a single run -- check, do not treat it as confirmed, until a second run agrees.'
        else '' end,
      case when b.competitor_domain is not null then format(' %s ranks #%s.', b.competitor_domain, b.competitor_position) else '' end
    ) as suggested_action
  from base b
  where b.our_serp_position is null
    and b.results_in_latest_run is not null
    and (b.sc_clicks_28d > 0 or b.sc_impressions_28d > 0 or b.search_console_avg_position_28d is not null)

  union all

  -- c. page_two -- rank 11-20.
  select
    b.company_entity_id, 'page_two', 'Page two, one push from page one',
    b.keyword_id, b.keyword, null::text[],
    b.provider, b.device, b.location_name,
    b.our_serp_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    null::jsonb,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement,
    null::boolean,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      b.sc_impressions_28d::numeric * greatest(b.our_serp_position - 10, 1)
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when b.sc_clicks_28d > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('We rank #%s on %s for "%s" (%s Search Console impressions, 28d) -- page two.%s',
      b.our_serp_position, b.device, b.keyword, b.sc_impressions_28d,
      case when b.competitor_domain is not null
        then format(' %s ranks #%s with a %s page.', b.competitor_domain, b.competitor_position, coalesce(b.competitor_page_type, 'unclassified'))
        else '' end
    ) as suggested_action
  from base b
  where b.our_serp_position between 11 and 20

  union all

  -- e. content_brief -- a competitor ranks with an ARTICLE where we rank with
  -- a collection/home page or do not rank; PAA questions as the outline.
  select
    b.company_entity_id, 'content_brief', 'Content brief',
    b.keyword_id, b.keyword, null::text[],
    b.provider, b.device, b.location_name,
    b.our_serp_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    coalesce(paa.questions, '[]'::jsonb) as paa_questions,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement,
    null::boolean,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      b.sc_impressions_28d::numeric
      * greatest(case when b.our_serp_position is null then 1
                       when b.our_serp_position <= 10 then b.our_serp_position - 3
                       else b.our_serp_position - 10 end, 1)
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when b.sc_clicks_28d > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('%s ranks #%s for "%s" with an article; we %s.%s A page type is a classification of the URL, not the content -- treat this as a hypothesis to test, not a cause. %s question%s from "People also ask" %s the outline.',
      b.competitor_domain, b.competitor_position, b.keyword,
      case when b.our_serp_position is null then 'do not appear in the observed results'
           else format('rank #%s with a %s page', b.our_serp_position, coalesce(b.our_page_type, 'unclassified')) end,
      '',
      coalesce(jsonb_array_length(paa.questions), 0),
      case when coalesce(jsonb_array_length(paa.questions), 0) = 1 then '' else 's' end,
      case when coalesce(jsonb_array_length(paa.questions), 0) = 0 then 'would be' else 'are' end
    ) as suggested_action
  from base b
  left join paa on paa.run_id = b.latest_run_id and paa.keyword_id = b.keyword_id
  where b.competitor_page_type = 'article'
    and (b.our_page_type is null or b.our_page_type in ('collection', 'home'))

  union all

  -- f. defend -- top-3 with meaningful clicks, flagged when movement is
  -- negative. ALWAYS worded as the two-run transition (see the migration
  -- header comment on why "3+ runs" is not attempted here).
  select
    b.company_entity_id, 'defend', 'Defend',
    b.keyword_id, b.keyword, null::text[],
    b.provider, b.device, b.location_name,
    b.our_serp_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    null::jsonb,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement,
    (coalesce(b.our_serp_movement, 0) < 0) as is_at_risk,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      b.sc_impressions_28d::numeric * greatest(4 - b.our_serp_position, 1)
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when b.sc_clicks_28d > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('We rank #%s on %s for "%s" with %s clicks (28d).%s',
      b.our_serp_position, b.device, b.keyword, b.sc_clicks_28d,
      case when b.our_serp_movement is not null and b.our_serp_movement < 0
        then format(' Moved down %s position%s between the two most recent runs -- not a trend, just the latest transition.',
          abs(b.our_serp_movement), case when abs(b.our_serp_movement) = 1 then '' else 's' end)
        else ' No decline between the two most recent runs.' end
    ) as suggested_action
  from base b
  where b.our_serp_position between 1 and 3
    and b.sc_clicks_28d > 0

  union all

  -- d. missing_category -- a cluster of active keywords sharing a stem, with
  -- demand, none ever ranked. Scores on impressions alone (no SERP run to
  -- discount by; "impressions (28d)" becomes the cluster's 90-day total,
  -- the only demand figure a never-ranking cluster can have).
  select
    cf.company_entity_id, 'missing_category', 'Missing category',
    null::uuid, cf.stem, cf.keywords,
    null::text, null::text, null::text,
    null::integer, null::text, null::text,
    null::text, null::text, null::integer, null::text,
    null::jsonb,
    null::text, null::text[], null::text, null::text[],
    cf.clicks, cf.impressions, null::numeric,
    null::integer, null::integer,
    null::boolean,
    false,
    round(cf.impressions::numeric, 2) as score,
    case when cf.clicks > 0 then 'moderate' else 'early' end as evidence_strength,
    format('%s active keywords (%s) share the opening phrase "%s" -- %s combined Search Console impressions and %s clicks (90d) -- and none has ever ranked in an observed SERP.',
      cf.keyword_count, array_to_string(cf.keywords, ', '), cf.stem, cf.impressions, cf.clicks
    ) as suggested_action
  from cluster_final cf
)
select * from unioned
order by score desc nulls last;

comment on view public.seo_recommendations_v is
  'ONE ranked, evidenced SEO opportunity list, read by both /v2/seo-keywords.html '
  '(Recommendations tab) and Ask SILO. Six opportunity_class values: '
  'page_one_not_top3 (rank 4-10 with demand), absent_with_demand (a run '
  'happened, we are absent, Search Console shows demand -- ABSENCE IS NEVER '
  'ZERO, and this reads "check, one snapshot" until observation_runs >= 2), '
  'page_two (rank 11-20), missing_category (a cluster of active keywords '
  'sharing a stem, with demand, none ever ranked -- keyword_id is NULL and '
  'keyword_cluster carries the list), content_brief (a competitor ranks with '
  'an ARTICLE page type -- a classification of the URL, never of the content '
  '-- where we rank with a collection/home page or do not rank; paa_questions '
  'is the outline), defend (top-3 with meaningful clicks, is_at_risk true when '
  'movement between the two most recent runs was negative -- never claimed as '
  'a trend). evidence_strength is EXACTLY strong/moderate/early, never a '
  'percentage or numeric confidence. score = Search Console impressions (28d, '
  'or the cluster''s 90d total for missing_category) x rank-gap-to-target, '
  'halved when observation_runs < 2 -- see the migration file for the full '
  'formula, reproduced identically in v2/seo-keywords.html''s table foot. '
  'our_position/competitor_* fields are NULL when not observed, never a '
  'synthesized zero. This is a REVIEWABLE LIST: nothing here writes to '
  'seo_tasks -- a person clicks Create SEO task, edits the pre-filled draft, '
  'and confirms.';

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('seo_recommendations_v', 'v', '[]'::jsonb,
   'THE ranked, evidenced SEO opportunity list -- what to fix first, built from '
   'SERP observations, Search Console and competitor captures, never from a '
   'name guess. opportunity_class is one of page_one_not_top3, '
   'absent_with_demand, page_two, missing_category, content_brief, defend. '
   'THREE ABSENCES STAY THREE STRINGS, never a zero: our_position NULL means '
   'not in the observed results (see seo_keyword_landscape_v for '
   '"never observed" vs "nothing returned" vs NEVER OBSERVED at that depth); '
   'competitor_domain/url/page_type NULL means no competitor was captured '
   'above us; the captured-title/h1 columns NULL mean "not captured", never '
   'blank text. absent_with_demand reads "check, one snapshot" until '
   'observation_runs >= 2 -- do not present a single-run absence as confirmed. '
   'evidence_strength is EXACTLY strong / moderate / early -- NEVER present it '
   'as a percentage or a numeric confidence. defend''s is_at_risk reflects '
   'movement between the two MOST RECENT runs only -- never call it a trend. '
   'A page_type is a classification of the ranking URL (seo_serp_page_type()), '
   'never a reading of the page''s content, and a title/H1 difference in the '
   'captures is a HYPOTHESIS to test, never a stated cause. This is a '
   'REVIEWABLE LIST: nothing writes seo_tasks from here automatically.',
   array['seo','recommendations','opportunities','what to fix','prioritize','content brief','defend','missing category'])
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

-- ── Closing the "two tabs create two projects" race ─────────────────────────
-- Adversarial review of the integrated Create-SEO-task path (v2/seo-keywords.html
-- findOrCreateSeoProject()): seo_projects (20260909240000) carries no
-- uniqueness on name at all, so two people confirming their first task at the
-- same moment could each pass the "does SEO Recommendations exist" read and
-- both insert -- two projects, silently. The page already re-reads and adopts
-- the existing row on an INSERT ERROR (the standard "find, insert, and on a
-- conflict re-read rather than fail" shape used elsewhere in this schema --
-- see platform_invites.created_company_id and stripe_invoice_requests), which
-- only works if a conflict is actually raised. This index is what raises it.
-- Scoped to exactly the one name this code path writes, not a general
-- per-company project-name uniqueness rule the rest of the workflow never
-- asked for.
create unique index if not exists seo_projects_recommendations_singleton
  on public.seo_projects (company_entity_id)
  where name = 'SEO Recommendations';

select public.refresh_chat_schema_catalog();
