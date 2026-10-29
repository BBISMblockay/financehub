-- ============================================================
-- Ad Studio idea bank: what an idea in Testing is testing
--
-- The board gained a 'testing' stage (20261029180000) but no
-- place to say WHAT is being tested, so "product fill out" or
-- "hook" lived in the free notes of whoever wrote them and the
-- next test of the same element started from nothing.
--
-- One optional column, deliberately free text rather than an
-- enum: marketing names what it varies in its own words, and a
-- fixed list would be wrong the first week. /v2/ad-studio.html
-- offers the values already used in the company as suggestions
-- (a datalist), which is what keeps them consistent WITHOUT a
-- constraint deciding the vocabulary.
--
-- The CHECK only bounds it and refuses an all-whitespace or
-- untrimmed value, so ' Hook ' and 'Hook' can never become two
-- entries in that suggestion list. Nothing clears the column
-- when an idea moves on: the element a live idea was testing is
-- part of its record, and the result is read off the linked
-- ad's summary card afterwards.
--
-- Re-running is a no-op: the column is added if missing and the
-- constraint is dropped and recreated. No existing row can fail
-- it -- the column starts NULL everywhere.
-- ============================================================

alter table public.ad_ideas
  add column if not exists testing_element text;

alter table public.ad_ideas
  drop constraint if exists ad_ideas_testing_element_check;

alter table public.ad_ideas
  add constraint ad_ideas_testing_element_check
  check (
    testing_element is null
    or (
      testing_element = btrim(testing_element)
      and char_length(testing_element) between 1 and 120
    )
  );

comment on column public.ad_ideas.testing_element is
  'What this idea is testing, in the team''s own words (e.g. "Product fill '
  'out"), set when the idea moves to the testing stage and KEPT afterwards as '
  'part of its record. Free text, trimmed, at most 120 characters: '
  '/v2/ad-studio.html suggests the values already used in the company rather '
  'than a fixed list. NULL means nobody said, never "nothing".';

-- Ask SILO's description of the table, rewritten here so it names the column
-- rather than describing a shape that no longer matches.
update public.silo_chat_schema_catalog
   set description = 'Ad Studio''s idea bank: ad ideas the team is working on, each built from '
                     'past Meta ads (baseline_ad_ids, joinable to meta_ad_creatives.ad_id) with '
                     'the bar to beat FROZEN when it was created (baseline_snapshot: objective, '
                     'metric, value, the sums behind it and their window). status idea / '
                     'testing / approved / in_production / live / retired; live_ad_ids names the '
                     'ads that carry a launched idea. testing_element is free text naming what '
                     'an idea is testing (NULL = nobody said). baseline_snapshot.value is '
                     'Meta-REPORTED where the metric is ROAS. An idea is a plan, never evidence '
                     'of performance.',
       updated_at = now()
 where relname = 'ad_ideas';

select public.refresh_chat_schema_catalog();
