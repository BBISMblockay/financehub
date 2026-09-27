-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-corrective: two places seo_recommendations_v collapsed "never
-- observed" into a fabricated zero, which is exactly the class of error this
-- module's own migrations repeatedly warn against. Found by a UI audit
-- against production (Astra, 2026-09-27) on real content_brief rows for
-- generic collection terms (Americana, Bat, Book, "42 Sale 2026 - All"):
--
-- 1. base's sc_clicks_28d / sc_impressions_28d used
--    coalesce(l.search_console_..., 0) unconditionally. For the three classes
--    that filter on demand (page_one_not_top3, page_two require impressions
--    > 0; defend requires clicks > 0) this was invisible, because NULL and 0
--    both fail an ">0" test -- so the class membership these fields gate was
--    never wrong. But content_brief has no demand filter at all, and a
--    keyword Search Console never returned a query row for (not "returned
--    with zero clicks", but never in search_console_query_daily for the
--    window at all) showed a hard "0" in both columns -- indistinguishable
--    from a keyword Search Console actually measured at zero. The Rankings
--    tab already says "not a returned query" for the same keywords; this
--    view said "0". Fixed by dropping the coalesce: these two columns are
--    now NULL exactly when seo_keyword_landscape_v's own
--    search_console_clicks_28d/_impressions_28d are NULL, and the page
--    already renders a NULL cell blank (v2/seo-keywords.html's scCell()).
--
-- 2. content_brief's paa_questions used coalesce(paa.questions, '[]'::jsonb),
--    and the sentence used coalesce(jsonb_array_length(paa.questions), 0) --
--    so a keyword with NO People Also Ask block observed in the run (paa has
--    no row for it at all) read as "0 questions from People also ask would
--    be the outline", identical wording to a genuinely empty outline. The
--    paa CTE can never produce a row with zero elements (it aggregates only
--    titled entries and GROUP BY yields no row when nothing qualifies), so
--    "0" was never a real, measured value here -- every occurrence was an
--    absence dressed as a count. Fixed: paa_questions is NULL when no block
--    was observed, and the sentence now says so explicitly rather than
--    computing a phantom zero.
--
-- Everything else -- the other four classes' formulas, evidence_strength,
-- scoring, missing_category -- is untouched. Same technique as
-- 20260927120000: CREATE OR REPLACE VIEW with an unchanged column list.
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists public.seo_recommendations_v;
create view public.seo_recommendations_v
with (security_invoker = true) as
with base as (
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
    l.search_console_clicks_28d::bigint      as sc_clicks_28d,
    l.search_console_impressions_28d::bigint as sc_impressions_28d,
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
  select f.run_id, f.keyword_id, jsonb_agg(distinct e ->> 'title') as questions
  from public.seo_serp_features_v f
  cross join lateral jsonb_array_elements(coalesce(f.details -> 'entries', '[]'::jsonb)) e
  where f.feature_type = 'people_also_ask' and nullif(e ->> 'title', '') is not null
  group by f.run_id, f.keyword_id
),
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

  -- e. content_brief -- CHANGED HERE: sc_clicks_28d/sc_impressions_28d can now
  -- be genuinely NULL (this class has no demand filter, so it's the one place
  -- a never-queried keyword's fabricated zero was visible), and paa_questions
  -- distinguishes "no PAA block observed" from any measured count.
  select
    b.company_entity_id, 'content_brief', 'Content brief',
    b.keyword_id, b.keyword, null::text[],
    b.provider, b.device, b.location_name,
    b.our_serp_position, b.our_url, b.our_page_type,
    b.competitor_domain, b.competitor_url, b.competitor_position, b.competitor_page_type,
    paa.questions as paa_questions,
    b.our_captured_title, b.our_captured_h1, b.competitor_captured_title, b.competitor_captured_h1,
    b.sc_clicks_28d, b.sc_impressions_28d, b.search_console_avg_position_28d,
    b.observation_runs, b.our_serp_movement,
    null::boolean,
    (b.observation_runs is not null and b.observation_runs < 2) as observed_single_run,
    round(
      coalesce(b.sc_impressions_28d, 0)::numeric
      * greatest(case when b.our_serp_position is null then 1
                       when b.our_serp_position <= 10 then b.our_serp_position - 3
                       else b.our_serp_position - 10 end, 1)
      * case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end
    , 2) as score,
    case
      when b.observation_runs is null or b.observation_runs < 2 then 'early'
      when coalesce(b.sc_clicks_28d, 0) > 0 then 'strong'
      else 'moderate'
    end as evidence_strength,
    format('%s ranks #%s for "%s" with an article; we %s. A page type is a classification of the URL, not the content -- treat this as a hypothesis to test, not a cause.%s',
      b.competitor_domain, b.competitor_position, b.keyword,
      case when b.our_serp_position is null then 'do not appear in the observed results'
           else format('rank #%s with a %s page', b.our_serp_position, coalesce(b.our_page_type, 'unclassified')) end,
      case
        when paa.questions is null then ' No "People also ask" block was observed for this keyword -- there is no outline to start from yet.'
        when jsonb_array_length(paa.questions) = 1 then ' 1 question from "People also ask" is the outline.'
        else format(' %s questions from "People also ask" are the outline.', jsonb_array_length(paa.questions))
      end
    ) as suggested_action
  from base b
  left join paa on paa.run_id = b.latest_run_id and paa.keyword_id = b.keyword_id
  where b.competitor_page_type = 'article'
    and (b.our_page_type is null or b.our_page_type in ('collection', 'home'))

  union all

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
    true as is_at_risk,
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
    format('We rank #%s on %s for "%s" with %s clicks (28d). Moved down %s position%s between the two most recent runs -- not a trend, just the latest transition.',
      b.our_serp_position, b.device, b.keyword, b.sc_clicks_28d,
      abs(b.our_serp_movement), case when abs(b.our_serp_movement) = 1 then '' else 's' end
    ) as suggested_action
  from base b
  where b.our_serp_position between 1 and 3
    and b.sc_clicks_28d > 0
    and coalesce(b.our_serp_movement, 0) < 0

  union all

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
  'keyword_cluster carries the list; its sc_clicks/impressions columns are the '
  'cluster''s 90-DAY total, not the 28-day figure every other class carries), '
  'content_brief (a competitor ranks with an ARTICLE page type -- a '
  'classification of the URL, never of the content -- where we rank with a '
  'collection/home page or do not rank; paa_questions is the outline and is '
  'NULL when no People Also Ask block was observed, never an empty array '
  'standing in for "zero questions"; sc_clicks_28d/sc_impressions_28d are '
  'NULL when Search Console never returned that query at all, distinct from a '
  'measured zero -- this is the one class with no demand filter, so it is the '
  'one place that distinction is visible), defend (top-3 with meaningful '
  'clicks AND a MEASURED, ACTUALLY DECLINING movement between the two most '
  'recent runs -- a stable or single-run top-3 keyword is not a '
  'recommendation and does not appear here at all; is_at_risk is true for '
  'every row by construction). '
  'evidence_strength is EXACTLY strong/moderate/early, never a '
  'percentage or numeric confidence. score = Search Console impressions (28d, '
  'or the cluster''s 90d total for missing_category) x rank-gap-to-target, '
  'halved when observation_runs < 2 -- see the migration file for the full '
  'formula, reproduced identically in v2/seo-keywords.html''s table foot. '
  'our_position/competitor_* fields are NULL when not observed, never a '
  'synthesized zero. This is a REVIEWABLE LIST: nothing here writes to '
  'seo_tasks -- a person clicks Create SEO task, edits the pre-filled draft, '
  'and confirms.';

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
   'blank text; sc_clicks_28d/sc_impressions_28d are NULL when Search Console '
   'never returned that query, distinct from a measured zero (visible on '
   'content_brief, the one class with no demand filter); content_brief''s '
   'paa_questions is NULL when no "People also ask" block was observed, never '
   'an empty array meaning zero questions. absent_with_demand reads "check, '
   'one snapshot" until observation_runs >= 2 -- do not present a single-run '
   'absence as confirmed. evidence_strength is EXACTLY strong / moderate / '
   'early -- NEVER present it as a percentage or a numeric confidence. defend '
   'REQUIRES an ACTUALLY DECLINING movement between the two MOST RECENT runs '
   'to appear at all -- a stable or single-run top-3 keyword is not surfaced '
   'here, so every defend row is genuinely at risk; never call the decline a '
   'trend, it is one transition. missing_category''s clicks/impressions are '
   'the cluster''s 90-DAY total, not the 28-day figure every other class '
   'carries -- never present the two windows as the same period. A page_type '
   'is a classification of the ranking URL (seo_serp_page_type()), never a '
   'reading of the page''s content, and a title/H1 difference in the captures '
   'is a HYPOTHESIS to test, never a stated cause. This is a REVIEWABLE LIST: '
   'nothing writes seo_tasks from here automatically.',
   array['seo','recommendations','opportunities','what to fix','prioritize','content brief','defend','missing category'])
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

select public.refresh_chat_schema_catalog();
