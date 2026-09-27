# Ask SILO capacity

Sized for **10–15 regular users** (decision 2026-09-27; no per-user caps yet).

## Baseline, measured 2026-09-27 (`silo_chat_audit_log`)

| | |
|---|---|
| Volume | 80–160 questions/week, 2–5 users, 1–3 companies |
| Peak concurrency seen | 5 questions in one 5-minute window |
| Latency (since 2026-09-14, n=133) | p50 35.5 s, mean 48.9 s, p90 ~110 s |
| Where the time goes | model 42.1 s, database 2.9 s per request (3.5 model calls avg) |
| Statement timeouts | 11 of 133 requests had at least one (8 s `authenticated` limit) |
| Partial answers (time budget hit) | 2 → 6 per week, rising |
| Token usage / cost | **not recorded before this change** |

So a request is model-bound, not database-bound. The first things to break at 3–5× traffic:

- **Provider rate limits.** They're counted per organisation, and concurrent long investigations hit the input-tokens-per-minute limit first.
- **Unrecorded cost.** Nobody could say what a question costs.

## What the 2026-09-27 change does

1. **Provider pushback is retried, then reported plainly.**
   - A 429/529/5xx or dropped connection is retried up to twice (`provider-lib.mjs`). The wait follows the provider's `retry-after`, capped at 15 s; without one it's 1 s then 3 s.
   - A retry happens only if it can still finish inside the request's own budget.
   - If still refused, the person sees "busy, try again in about a minute" (HTTP 503, `provider_busy: true`), not the raw API error. The audit row records `error_message = 'provider_busy: <status>'`.
2. **The static core prompt is cached once for everyone.**
   - The system prompt is two blocks: the rules every request shares, cached for an hour, then this request's part (schema slice, date, taught notes, guidance).
   - Before, the per-question schema slice sat inside the only cached block, so no two questions shared a cache entry.
   - Cache reads cost ~0.1× and **do not count toward the input-token rate limit**. That makes this a capacity change as well as a cost one.
   - **A spend-cap 429 is not "busy".** Anthropic also answers 429 with `error.details.error_code = "enforced_spend_limit_reached"` when the organisation's spend cap is hit. That is never retried: the person is told an admin needs to raise the limit, with no Try again, and the row records `provider_spend_limit: 429`.
   - A refused request still records the rounds it used and the usage, retries and query outcomes gathered before the refusal.
3. **Every model call's usage is recorded**: `diagnostics.context.model_usage` (per call), `model_usage_total` and `provider_retries`.

## Watching it

Cache effectiveness and tokens per question (the first call of a request should show a large `cache_read` once the core is warm):

```sql
select date_trunc('day', created_at)::date day, count(*) questions,
  round(avg((diagnostics->'context'->'model_usage'->0->>'cache_read')::numeric)) first_call_cache_read,
  round(avg((diagnostics->'context'->'model_usage_total'->>'input')::numeric)) uncached_input,
  round(avg((diagnostics->'context'->'model_usage_total'->>'cache_read')::numeric)) cache_read,
  round(avg((diagnostics->'context'->'model_usage_total'->>'output')::numeric)) output
from silo_chat_audit_log
where diagnostics->'context' ? 'model_usage'
group by 1 order by 1 desc;
```

Provider pushback:

```sql
select date_trunc('day', created_at)::date day,
  count(*) filter (where error_message like 'provider_busy%') busy_failures,
  count(*) filter (where error_message like 'provider_spend_limit%') spend_cap_failures,
  count(*) filter (where jsonb_array_length(coalesce(diagnostics->'context'->'provider_retries','[]')) > 0) retried_then_ok
from silo_chat_audit_log group by 1 order by 1 desc limit 14;
```

Latency and partial answers:

```sql
select date_trunc('week', created_at)::date wk, count(*),
  round((percentile_cont(0.5) within group (order by (diagnostics->'context'->>'elapsed_ms')::numeric)/1000)::numeric,1) p50_s,
  round((percentile_cont(0.9) within group (order by (diagnostics->'context'->>'elapsed_ms')::numeric)/1000)::numeric,1) p90_s,
  count(*) filter (where (diagnostics->'context'->>'partial')::boolean) partial
from silo_chat_audit_log where created_at > now() - interval '8 weeks' group by 1 order by 1;
```

## When to take the next step

| Signal | Next lever (not built) |
|---|---|
| `busy_failures` on more than a couple of days a week | Ask for a higher API rate-limit tier; then per-person in-flight caps (declined for now) |
| `first_call_cache_read` near 0 after deploy | Something per-request leaked into the core block. `prompt.test.mjs` guards this, but check the live bytes |
| p90 above ~120 s, or partial answers climbing | Stream progress to the page, or run broad reviews as background jobs past the 150 s gateway limit |
| Statement timeouts above ~10% of requests | Precompute rollups for the queries that time out (the diagnostics column names them) |
| Cost per question is a concern | Effort/model tuning. That's a quality trade, so it's a deliberate decision, never a default |
