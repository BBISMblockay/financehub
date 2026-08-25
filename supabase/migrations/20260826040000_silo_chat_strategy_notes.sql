-- Strategy as a first-class taught note.
--
-- Notes already reach every request: buildSystemPrompt() injects them into
-- the cached system prompt, so anything taught here is in context for every
-- question including product-concept generation. What was missing is a
-- CATEGORY for forward-looking intent, and the framing that goes with it.
--
-- Why this matters beyond tidiness. A concept generator grounded entirely
-- in historical data converges on the historical mean: a new category, a
-- collab, a first youth line has no comparable, no sales history and no
-- precedent, so it scores worse than a restock of a proven seller every
-- single time. Left alone that system politely argues you out of growth.
--
-- A strategy note is the deliberate override. The evidence model already
-- has the right slot for it -- INPUT means "a human told us", as opposed to
-- DATA ("queried from SILO"). A stated strategic bet is legitimately INPUT:
-- it does not need historical support, it must not be dressed up as DATA,
-- and it must not be discounted for being neither. "Unproven and still the
-- right call" is a coherent position the system should be able to hold.
--
-- Distinct from the existing two categories:
--   brand   -- lasting identity/voice (tagline, positioning, personality)
--   general -- a fact/correction no query could derive (e.g. "the SKU
--              column is sku_snapshot"); a corrective lens on data
--   strategy -- forward-looking intent that should shape what SILO
--              PROPOSES, not just how it reads numbers
--
-- effective_until exists because strategy is the one category that goes
-- stale. "The SKU column is sku_snapshot" is true indefinitely; "we are
-- pushing youth in 2027" is not, and a strategy note silently steering
-- concepts two years later is a real hazard. Nullable -- an open-ended
-- direction is legitimate -- but when set, an expired note is surfaced as
-- expired rather than quietly applied.

alter table public.silo_chat_notes
  drop constraint if exists silo_chat_notes_category_check;
alter table public.silo_chat_notes
  add constraint silo_chat_notes_category_check
  check (category = any (array['general'::text, 'brand'::text, 'strategy'::text]));

alter table public.silo_chat_notes
  add column if not exists effective_until date;

comment on column public.silo_chat_notes.effective_until is
  'Optional horizon for a strategy note. Null = open-ended. Past = expired: still readable, but presented as expired rather than applied as current direction. Unused for brand/general notes, which do not go stale the same way.';

-- View gains the new column plus a computed expiry flag, so neither the
-- edge function nor the UI has to re-derive "is this still current".
drop view if exists public.silo_chat_notes_v;
create view public.silo_chat_notes_v
with (security_invoker = true) as
select
  n.id,
  n.note,
  n.category,
  n.effective_until,
  (n.effective_until is not null and n.effective_until < current_date) as is_expired,
  n.created_at,
  n.created_by,
  p.name as created_by_name,
  n.company_entity_id
from public.silo_chat_notes n
left join public.profiles p on p.id = n.created_by;

revoke all on public.silo_chat_notes_v from anon;
grant select on public.silo_chat_notes_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['note','notes','taught','knowledge','brand','strategy','correction','memory'],
  description = $d$Taught knowledge injected into every Ask SILO request. category is one of: "brand" (lasting identity/voice), "general" (a fact or correction no query could derive -- a corrective lens on how to read the data), or "strategy" (forward-looking intent that should shape what SILO proposes, not just how it reads numbers). A strategy note is INPUT-class evidence: it is a stated human bet, valid without historical support, and must never be presented as though it were queried data. effective_until optionally bounds a strategy note; is_expired marks one whose horizon has passed -- an expired note is context, not current direction.$d$
where relname in ('silo_chat_notes', 'silo_chat_notes_v');
