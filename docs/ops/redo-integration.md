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
(`redo_connections`, `redo_returns`).

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
return event means the webhook config or auth secret is wrong.

## Not yet built

- No UI page — `redo_returns` is queryable via SQL/Supabase only for now.
  A reconciliation view joining it against `sales_by_day` (or a
  `/v2/integrations.html` connection card, matching the ad-platforms
  pattern) is the natural next step once real webhook data is flowing.
- No backfill script — a new connection only sees returns from the moment
  the webhook is configured onward. A `GET /returns` history pull for
  pre-existing returns isn't built (see "not confirmed" list below).
- `GET /returns` (list) query params (pagination, date-range filters) are
  unconfirmed — only the single `GET /returns/{id}` and the webhook payload
  schemas were verified against Redo's docs while building this.
