-- Where an ad's copy actually came from.
--
-- The Week over Week creative table showed "not synced" for most ads, and the
-- reason was not Dynamic Creative as first guessed. Measured over ads that
-- SPENT since 2026-06-01:
--
--   VIDEO    39 ads,   $127,185 spend -- 39 of 39 carry creative.body
--   PHOTO     1 ad,      $1,936       --  1 of 1
--   SHARE   271 ads, $1,630,566       -- only 32 of 271
--                                        $1,159,168 of spend with no copy
--
-- 100% coverage on VIDEO and PHOTO is not what asset-feed fragmentation looks
-- like. Every gap is object_type = SHARE: an ad pointing at an EXISTING PAGE
-- POST rather than carrying its own creative, so creative.body is legitimately
-- empty -- the words live on the post, and the sync never asked for it.
--
-- The sync now tries three sources in order: creative.body, then
-- object_story_spec (link_data.message / video_data.message /
-- photo_data.caption) for ads built in place, then one batched read of the
-- page post named by effective_object_story_id.
--
-- This column records WHICH one produced the text. Without it, a jump from 35%
-- to some higher number is unattributable -- you cannot tell whether the post
-- lookup earned its extra request or whether object_story_spec quietly covered
-- everything, and the next person re-guesses exactly as this round did. It is
-- also how to spot the post pass silently failing: body_source stops showing
-- 'page_post' while SHARE ads go back to null.

alter table public.meta_ad_creatives
  add column if not exists body_source text;

comment on column public.meta_ad_creatives.body_source is
  'Which source produced body: creative_body | object_story_spec | page_post, or null when no copy was found. SHARE ads point at an existing Page post and carry no creative.body of their own, so page_post is the path that covers them. Recorded so a coverage change is attributable to a source rather than guessed at.';

comment on column public.meta_ad_creatives.body is
  'Ad copy, resolved in order: creative.body, then object_story_spec (link/video/photo message), then the message on the page post named by effective_object_story_id. Null means no copy was found on any of the three -- see body_source.';
