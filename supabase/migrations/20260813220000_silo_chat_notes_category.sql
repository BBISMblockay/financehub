-- =============================================================================
-- Ask SILO: brand context becomes per-company data, not hardcoded code
--
-- Until now, "About Baseballism" (tagline, positioning, voice) lived as a
-- hardcoded paragraph in supabase/functions/silo-chat/index.ts's
-- SYSTEM_PROMPT -- fine for a single-brand deployment, but it breaks the
-- moment a second company uses this same SILO instance: their execs would
-- get Baseballism's brand voice whether they wanted it or not, with no way
-- to change it short of editing code.
--
-- silo_chat_notes is already the right mechanism -- company-scoped via RLS,
-- editable through the Notes panel, no deploy required. This migration adds
-- a `category` so foundational brand identity ('brand') can be distinguished
-- from ad hoc taught corrections ('general', the default, e.g. "Pin of the
-- Month is a one-time drop") both in the UI and in how the edge function
-- assembles the system prompt -- then seeds Baseballism's existing brand
-- context as real rows, so it's now owned by the team, not code.
-- =============================================================================

alter table public.silo_chat_notes
  add column if not exists category text not null default 'general'
  check (category in ('general', 'brand'));

drop view if exists public.silo_chat_notes_v;
create view public.silo_chat_notes_v
with (security_invoker = true) as
select
  n.id,
  n.note,
  n.category,
  n.created_at,
  n.created_by,
  p.name as created_by_name,
  n.company_entity_id
from public.silo_chat_notes n
left join public.profiles p on p.id = n.created_by;

grant select on public.silo_chat_notes_v to authenticated;

-- Seed Baseballism's brand context (migrated out of index.ts's SYSTEM_PROMPT
-- in the same PR). Idempotent: skipped if Baseballism already has any
-- 'brand' notes, so re-running this migration never duplicates them.
insert into public.silo_chat_notes (company_entity_id, note, category, created_by)
select
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid,
  seed.note,
  'brand',
  (select id from public.profiles where email = 'blake@baseballism.com')
from (values
  ('Baseballism is a baseball lifestyle apparel brand -- vintage/retro-inspired designs and MLB-licensed product (Ken Griffey Jr., Babe Ruth, Roberto Clemente, Cubs, Dodgers, and others) built for people who live baseball on and off the field, not just players. Tagline: "The Original Baseball Lifestyle Brand. Built For Ballplayers, Worn By All."'),
  ('Brand personality is nostalgic and rooted in the game''s history, but playful and pun-driven rather than corporate -- collection names like "Bat Bros," "Money Ball," "Hardball Hunter," and "Doubles and Bubbles" are typical, and holidays get a baseball spin (Valentine''s -> "For Love of the Game"). Comfortable crossing into pop culture (Sonic the Hedgehog, Fortnite collabs) without losing the baseball-first identity.'),
  ('Retail footprint includes a flagship barn store on the actual Field of Dreams Movie Site in Dyersville, Iowa (Universal-licensed) -- a defining piece of brand identity, not just another wholesale account.'),
  ('Merch calendar leans on family/community moments (Father''s/Mother''s Day, Back to School, Toddler/Youth lines) alongside signature promo events (Anniversary Sale, "6432 Day").'),
  ('Voice: warm and knowledgeable, like someone who''s actually into baseball -- not generic-corporate. The playful/pun energy belongs to product and marketing copy, not to a data answer -- when answering a data question, keep the personality as tone, not as bits: lead with the number, stay direct, and only lean into the brand''s playfulness if the user is literally asking for campaign name ideas or marketing copy.')
) as seed(note)
where exists (select 1 from public.entities where id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid)
  and not exists (
    select 1 from public.silo_chat_notes
    where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid
      and category = 'brand'
  );
