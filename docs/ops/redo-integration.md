# Redo returns integration setup guide

One-time setup for pulling real Redo return data (refund / exchange / store-credit
dollar amounts) into Supabase, so the BI-vs-Shopify variance noted in
`docs/ops/bugs.md` ("Redo exchange/store-credit returns with $0 refund
subtotals") can be reconciled with actual numbers.

Unlike the ad-platforms sync, this is **push-based**: Redo's `Return event`
webhook POSTs the full return object to SILO on every status change. There
is no GitHub Action or polling job — the `redo-webhook` edge function
(`supabase/functions/redo-webhook/`) is the entire pipeline. Schema:
`supabase/migrations/20260812120000_redo_returns_integration.sql`
(`redo_connections`, `redo_returns`) and
`20260812130000_redo_return_items.sql` (`redo_return_items` — per-SKU
detail: reason, reason code, grade/outcome, exchange item; plus
`redo_returns.customer_email`/`customer_name`).

UI: `/v2/integrations.html` → Redo returns card. "Connect Redo…" creates
the `redo_connections` row and generates the webhook secret — no SQL
needed for steps 2–3 below, the card has Copy buttons for both the URL and
secret.

## 1. Deploy the edge function

Merging the PR does **not** deploy it (see the "Edge functions" note in
`CLAUDE.md`). Deploy manually via the Supabase MCP tools or CLI, and mark it
**public** (`verify_jwt = false`) — Redo authenticates with its own
subscriber-secret Bearer scheme, not a Supabase JWT, same model as
`review-portal` / `org-invite-redeem`.

## 2. Create the connection row

For each company, insert a `redo_connections` row and generate a random
webhook secret (any sufficiently random string — this is the value you'll
paste into Redo's dashboard, not a Redo-issued value):

```sql
insert into public.redo_connections (company_entity_id, display_name, webhook_secret, is_active)
values ('<company-entity-id>', 'Baseballism', '<random-secret>', true);
```

Baseballism's entity id: `3bd934c9-4cdd-429b-9076-f8f6b45d4eb7` (see `CLAUDE.md`).

Optionally also set `api_secret` to the store's `REDO_API_SECRET` (Merchant
Admin → API in Redo's dashboard) — not used by the webhook path today, but
kept for a future `GET /returns/{id}` backfill/verify script.

## 3. Point Redo's webhook at SILO

In Redo's merchant dashboard, add a webhook subscription:

- **URL**: `https://<project-ref>.supabase.co/functions/v1/redo-webhook/<company-entity-id>`
  (the company id goes in the URL path, not the payload — each company's
  Redo store points at its own URL)
- **Event**: Return event (all statuses)
- **Auth secret**: the same value you set as `webhook_secret` in step 2 —
  Redo sends it back as `Authorization: Bearer <secret>` on every delivery,
  which the edge function checks against that company's row.

## 4. Verify

Trigger a test return in Redo's dashboard (or wait for a real one) and check:

```sql
select redo_return_id, shopify_order_name, status, refund_amount, exchange_amount, store_credit_amount, last_event_type, updated_at
from public.redo_returns
where company_entity_id = '<company-entity-id>'
order by updated_at desc
limit 10;
```

`redo_connections.last_event_at` / `last_event_type` on the connection row
updates on every successful delivery — a stale `last_event_at` after a known
return event means the webhook config or auth secret is wrong. Per-item
detail lands in `redo_return_items` (one row per `redo_returns.id`, keyed by
`redo_item_id`; `sku`/`reason`/`reason_code`/`grade`/`outcome` are the
useful analytics columns).

**Observed on first connect (2026-08-12, Baseballism)**: Redo delivered a
burst of `updated` events for existing returns going back to 2026-08-01
immediately after the webhook was created — not just new returns from that
point forward. Whether that's a fixed lookback window, a one-time sync on
webhook creation, or ongoing background reconciliation isn't confirmed; it
means new connections may get some backfill for free, but a large or
old accounts may still need the manual backfill below.

## Historical backfill (not yet built)

Beyond whatever Redo automatically resent on connect, a deliberate backfill
of everything before that would need `GET /returns` (list) against
`api.getredo.com` using the connection's `api_secret`, paginating through
and POSTing each result through the same upsert logic `redo-webhook` uses
(or a shared helper). Not built because the `List Returns` endpoint's query
params (pagination cursor, date-range filters) weren't confirmed against
Redo's docs while building this — only `GET /returns/{id}` and the webhook
payload schemas were. Grab that endpoint's OpenAPI page from
developers.redo.com before building the backfill script.

## Not yet built

- No reconciliation view — `redo_returns`/`redo_return_items` are queryable
  via SQL/Supabase only. A view joining `redo_returns` against `sales_by_day`
  to actually surface the BI variance fix is the natural next step.
- No historical backfill script — see above.
