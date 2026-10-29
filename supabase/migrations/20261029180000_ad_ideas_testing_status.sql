-- ============================================================
-- Ad Studio idea bank: a 'testing' stage before 'approved'
--
-- The board was idea -> approved -> in_production -> live ->
-- retired, which gave a team no place to put an idea that is
-- being trialled before anyone signs off on it. This adds
-- 'testing' between 'idea' and 'approved'.
--
-- Two things change together:
--
-- 1. ad_ideas_status_check gains the value. The constraint is
--    dropped and recreated, and every value already stored
--    ('idea', 'approved', 'in_production', 'live', 'retired')
--    stays valid, so no existing row can fail validation and a
--    re-run is a no-op.
--
-- 2. ad_ideas_guard clears approved_by / approved_at for
--    'testing' the same way it does for 'idea'. 'testing' sits
--    BEFORE approval, so an idea moved back there must not keep
--    a stamp saying who approved it -- otherwise a demoted idea
--    would still read as approved in the record. Moving it
--    forward into 'approved' re-stamps it, as before.
--
-- v2/ad-studio.js carries the matching board column.
-- ============================================================

alter table public.ad_ideas
  drop constraint if exists ad_ideas_status_check;

alter table public.ad_ideas
  add constraint ad_ideas_status_check
  check (status in (
    'idea',
    'testing',
    'approved',
    'in_production',
    'live',
    'retired'
  ));

create or replace function public.ad_ideas_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.company_entity_id is distinct from old.company_entity_id then
      raise exception 'ad_ideas: an idea cannot move to another company';
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'ad_ideas: created_by / created_at are fixed';
    end if;
    -- The bar is frozen once set. Re-baselining is a new idea, so the record
    -- of what the original was measured against survives.
    if old.baseline_snapshot is not null and new.baseline_snapshot is distinct from old.baseline_snapshot then
      raise exception 'ad_ideas: baseline_snapshot is frozen once set -- start a new idea to change the bar';
    end if;
    -- The ads the bar was taken from are part of the bar.
    if old.baseline_snapshot is not null and new.baseline_ad_ids is distinct from old.baseline_ad_ids then
      raise exception 'ad_ideas: baseline_ad_ids is frozen with the bar -- start a new idea to change the baselines';
    end if;
  end if;
  -- approved_by / approved_at are stamped here, never taken from the client:
  -- set on the move INTO approved, kept while the idea moves on through
  -- production and live, cleared if it goes back to a stage before approval
  -- (a plain idea, or testing).
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif tg_op = 'INSERT' or new.status in ('idea', 'testing') then
    new.approved_by := null;
    new.approved_at := null;
  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ad_ideas_guard on public.ad_ideas;
create trigger trg_ad_ideas_guard before insert or update on public.ad_ideas
  for each row execute function public.ad_ideas_guard();

comment on table public.ad_ideas is
  'Ad Studio''s idea bank: an ad idea (title, hook, angle, draft copy, format, '
  'objective, destination) built FROM past ads (baseline_ad_ids) with the bar '
  'it must beat FROZEN at creation (baseline_snapshot: objective, the metric it '
  'is judged on, the pooled value and the sums behind it, the window). Status '
  'idea -> testing -> approved -> in_production -> live -> retired; a live idea '
  'names the Meta ads carrying it (live_ad_ids) and is measured against the '
  'frozen bar, never against a baseline recomputed later.';

-- Ask SILO's description of the table lists the statuses, so it is rewritten
-- here rather than left naming a stage set that no longer matches.
update public.silo_chat_schema_catalog
   set description = 'Ad Studio''s idea bank: ad ideas the team is working on, each built from '
                     'past Meta ads (baseline_ad_ids, joinable to meta_ad_creatives.ad_id) with '
                     'the bar to beat FROZEN when it was created (baseline_snapshot: objective, '
                     'metric, value, the sums behind it and their window). status idea / '
                     'testing / approved / in_production / live / retired; live_ad_ids names the '
                     'ads that carry a launched idea. baseline_snapshot.value is Meta-REPORTED '
                     'where the metric is ROAS. An idea is a plan, never evidence of performance.',
       updated_at = now()
 where relname = 'ad_ideas';

select public.refresh_chat_schema_catalog();
