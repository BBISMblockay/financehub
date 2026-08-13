# Ask SILO (chat) setup guide

`/v2/silo-chat.html` is an open-ended chat for asking natural-language
questions about SILO's own data. Unlike the nightly Insights digest
(`scripts/generate-insights.mjs`, a fixed set of SQL rules narrated by
Claude), this is genuinely "ask anything" — Claude gets one tool,
`run_sql`, and writes its own read-only Postgres queries per question.

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

## Required: ANTHROPIC_API_KEY

**Not set yet.** The edge function returns a clear 503 error until it is.
This is the same gap that's been silently limiting the nightly Insights
digest to findings-only (no narrative) — see `scripts/generate-insights.mjs`.

Set it once, as a Supabase edge-function secret (Dashboard → Edge Functions
→ Secrets, or `supabase secrets set ANTHROPIC_API_KEY=...`) — it isn't a
GitHub repo secret since edge functions don't read those. Once set, both
the chat and the Insights narrative pick it up immediately (no redeploy
needed for env var changes).

Optional: `CHAT_MODEL` (defaults to `claude-sonnet-5`, matching the
Insights script's own default).

## What it can't do

- **Write anything.** `chat_run_readonly_query` only ever runs
  read-only statements — there's no path from this chat to an INSERT,
  UPDATE, DELETE, or DDL statement.
- **See across companies.** RLS is the boundary, not a company filter the
  model has to remember to add.
- **Cite department-private data it isn't RLS-cleared for** — e.g. review
  `private_notes` are author-only. The model will just get zero rows back
  for those, not an error, since RLS silently filters rather than denies.

## Not yet built

- No conversation persistence — history lives in the browser tab only
  ("New chat" clears it, refresh loses it).
- No usage/cost guardrails beyond the 8-tool-round cap per question — worth
  watching Anthropic API spend once this is in real use, since "wide open"
  means there's no fixed set of cheap canned queries.
