-- Free-text audience on the launch brief is hard for Ask SILO (or anyone)
-- to pattern-match across launches -- "16-30 year old demographic" vs.
-- "16-30 demo" vs. "Gen Z" are the same segment but don't compare as text.
-- Adds a structured, repeatable tag array alongside the existing free-text
-- audience column (kept for the "why" nuance a tag can't carry). No fixed
-- taxonomy is seeded -- SILO is multi-tenant and each company's audience
-- segments differ, so the UI grows the vocabulary from what's actually
-- typed rather than guessing a canonical list up front.
alter table public.launch_calendar
  add column if not exists audience_tags text[] not null default '{}';

create index if not exists launch_calendar_audience_tags_gin
  on public.launch_calendar using gin (audience_tags);
