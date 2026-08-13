# Ask SILO (chat) setup guide

`/v2/silo-chat.html` is an open-ended chat for asking natural-language
questions about SILO's own data. Unlike the nightly Insights digest
(`scripts/generate-insights.mjs`, a fixed set of SQL rules narrated by
Claude), this is genuinely "ask anything" — Claude gets two tools:
`run_sql`, which writes its own read-only Postgres queries per question,
and `save_note`, which records taught knowledge — either a specific
correction or foundational brand context — for future questions to weigh
(see "Taught knowledge" below).

## How it's scoped safely

There is no hand-picked list of allowed questions. The safety boundary is
Postgres row-level security itself:

- `chat_run_readonly_query(text)` (`supabase/migrations/20260813180000_silo_chat_readonly_query.sql`)
  is `SECURITY INVOKER` — it runs as the *calling* authenticated user, not
  service role, so every table/view's existing RLS policy
  (`company_entity_id = active_company_id()`) applies exactly as it does
  everywhere else in SILO.
- The `silo-chat` edge function forwards the caller's own JWT to Supabase
  (never the service-role key) — same "caller-scoped client" pattern as
  `mail-item-notify`.
- Defense in depth beyond RLS: only a single `SELECT`/`WITH` statement is
  accepted, no semicolons (blocks multi-statement injection — the query is
  also wrapped as a subquery expression, which is a hard Postgres syntax
  error if it contains a second statement), rows capped at 500, and a 10s
  statement timeout.

Net effect: a user can never see through this chat anything they couldn't
already see by hand-querying from the browser with their own login.

## Taught knowledge (silo_chat_notes)

`silo_chat_notes` (`supabase/migrations/20260813210000_silo_chat_notes.sql`,
extended by `20260813220000_silo_chat_notes_category.sql`) is a small,
shared, company-scoped table for things no query can derive on its own. A
human teaches the model something ("remember that...", "note that...") and
the `save_note` tool records it. Every subsequent request re-fetches the
full notes list and folds it into the system prompt (see
`buildSystemPrompt` in `supabase/functions/silo-chat/index.ts`), so it's
ambient context on every question, not something the model has to think to
look up.

Notes come in two categories, both stored in the same table, split by a
`category` column:
- **`brand`** — foundational, company-specific identity: tagline,
  positioning, personality, target customer, retail footprint. Renders as
  its own "Brand context" section in the system prompt, above the general
  notes, and grounds the model's tone/voice. **Nothing about brand identity
  is hardcoded in the edge function** — a company with zero `brand` notes
  gets a neutral, professional Ask SILO with no invented personality. This
  is what makes Ask SILO's "brand voice" genuinely multi-tenant instead of
  baked into code for one company; see the migration for how Baseballism's
  previously-hardcoded brand paragraph was seeded as real rows instead.
- **`general`** (the default) — a specific fact/correction, e.g. "Pin of
  the Month is a one-time monthly collectible drop, not a restock signal."
  Renders in the "Taught institutional knowledge" section, attributed to
  whoever taught it.

Because this is *shared* memory — one person's note changes every future
answer for the whole company, not just their own session — writing is
narrower than reading:
- **Read**: any active company member (`silo_chat_notes_active_select`
  RLS policy), same as most SILO tables. The Notes panel in
  `/v2/silo-chat.html` (header → "Notes") shows both categories to
  everyone.
- **Write** (insert or delete): `is_exec_or_owner()` only — the same gate
  used for review-template writes and whole-company roster visibility. The
  Notes panel's add/delete controls only render for exec/owner-tier users
  (a client-side check for UX, mirroring the pattern in
  `review-templates.html`); everyone else sees a read-only list. If a
  non-exec/owner user asks the model itself to remember something, the
  insert is denied by RLS and the model is expected to say so plainly
  rather than claim success.

## Required: ANTHROPIC_API_KEY

Configured as a Supabase edge-function secret (Dashboard → Edge Functions
→ Secrets, or `supabase secrets set ANTHROPIC_API_KEY=...`) — it isn't a
GitHub repo secret since edge functions don't read those. Both the chat
and the Insights narrative (`scripts/generate-insights.mjs`) read the same
key; without it, `silo-chat` returns a clear 503 instead of failing
opaquely.

Optional: `CHAT_MODEL` (defaults to `claude-sonnet-5`, matching the
Insights script's own default).

## What it can't do

- **Write real business data.** `chat_run_readonly_query` only ever runs
  read-only statements against operational tables — there's no path from
  this chat to an INSERT/UPDATE/DELETE/DDL on `sales_by_day`,
  `po_headers`, or anything else that isn't `silo_chat_notes`. The one
  write path that exists (`save_note`) touches nothing but that one
  notes table, and is itself RLS-gated to exec/owner.
- **See across companies.** RLS is the boundary, not a company filter the
  model has to remember to add.
- **Cite department-private data it isn't RLS-cleared for** — e.g. review
  `private_notes` are author-only. The model will just get zero rows back
  for those, not an error, since RLS silently filters rather than denies.

## Not yet built

- No conversation persistence — history lives in the browser tab only
  ("New chat" clears it, refresh loses it). Taught notes (above) persist
  across conversations; the message transcript itself does not.
- No usage/cost guardrails beyond the 8-tool-round cap per question and
  prompt caching (`cache_control` on the system prompt, cuts repeat-round
  cost within a question) — worth continuing to watch Anthropic API spend
  as real usage grows, since "wide open" means there's no fixed set of
  cheap canned queries.
