# Shopify online sales default

A Shopify connection with no configured fallback used to skip order lines with
no resolvable location (`rows_skipped.no_location_lines`) while reporting a
successful sales sync. The first sales sync now provisions a real SILO online
reporting location named `<company title> Online` (for example, `Bat Nutz Online`).
The name is editable in Integrations → Map locations. Its stable code is
`shopify_online_<connection UUID without hyphens>`; its bigint SILO ID, code and
Shopify's own location IDs are separate identities. Renaming never changes the
code, so sale/refund hashes and reporting channel membership stay stable.

## Precedence and scope

- Explicit Shopify mappings and legacy `locations.shopify_location_id` mappings
  win when a source ID matches. Explicit connection mappings are loaded for the
  company **and connection**, never borrowed from another store in that company.
- An existing nonblank `default_location_code` keeps its legacy fallback
  behavior. Its label comes from the same-company SILO location when available.
- With no code, a deliberately selected `connection.location_id` (SILO FK) is
  preserved and used; an invalid/cross-company pointer fails closed.
- Otherwise the service-only `ensure_shopify_sales_default` RPC creates the
  company-named, `store_type = 'online'` reporting location atomically. Empty
  company titles fall back to shop name, then shop domain, then `Shopify`.
- This generated default covers absent sales-location IDs and known `web`
  orders whose only unmapped IDs belong to fulfillments. A fulfillment warehouse
  is not evidence of a POS sale. A **mapped** fulfillment still wins.
- An unmapped order/line sales location (or an unmapped fulfillment for an
  unknown/POS channel) stays an actionable mapping error. An incremental rebuild
  refuses before deleting that window's existing rows. A history chunk refuses
  before writing rows or advancing its cursor, but **a fresh/restarted full
  history import still purges the whole shop before fetching its first chunk**.
  This existing destructive reset is not redesigned here: an unmapped real ID
  discovered afterwards can leave history deleted/partial. Setup failures are
  checked before that initial purge; source-mapping failures are not preflighted
  over the entire historical range. Do not use a full-history restart as the
  pilot/replay for this change.
- Inventory still requires a real Shopify-location mapping. This default creates
  no stock and does not point an invented ID at Shopify. Catalog is unchanged.

## Atomicity, permissions and existing limitations

The RPC is SECURITY INVOKER and executable only by `service_role`. It reads the
company from the locked connection, never from a caller-supplied company/name.
An explicit default is not modified. The location insert and connection pointer
update share one transaction; retries return the same code and preserve renames.

`locations.id` currently has no sequence. Initial provisioning takes a table
write lock around the existing max+1 identity convention; concurrent syncs cannot
allocate the same ID. The unrelated legacy UI allocator reserves max+1 before
its separate insert, so a simultaneous UI creation may encounter a visible PK
conflict and need retry. The PK prevents an overwrite. Replacing that allocator
is a separate change. PGlite tests execute real PostgreSQL semantics but are
single-session; genuine two-client contention has not been exercised here.

Changing a display name refreshes sales-row labels as their days are normally
rebuilt. It does not rewrite historical rows or rename a Shopify location.
Changing the selected fallback changes attribution for future/replayed windows;
old windows require an explicitly authorized replay if historical reattribution
is desired. No data migration/backfill is implicit in this PR.

## Rollout (requires separate production authorization)

1. Apply `20261002031446_shopify_online_sales_default.sql`; applying it alone
   changes no connection or location rows. Run `verify_v2_schema.sql` and confirm
   the new service-only/invoker check and other applicable checks are `ok`.
2. Merge the tested Node/UI change. The Node sales path now requires that RPC;
   do not leave the scheduled sync on new code before the migration is applied.
3. Deploy `shopify-sync-run` through `deploy-edge-function.yml`. The bundled
   `ad-platform-sync-run` Shopify utility mirror also changed to remain identical
   to Node; deploy it to reconcile source drift, though its ad behavior is unchanged.
4. Run a bounded, single-connection sales replay only after authorization, then
   verify the sales count/totals, zero `no_location_lines`, preserved explicit
   mappings, online channel inclusion and successful exact sync-job result.

## Bat Nutz replay proposal (not executed)

Verified read-only on 2026-10-02: company title `Bat Nutz`, connection
`11ff0bda-62fc-4bf7-bed5-080d1001e09f`, company
`998f69e6-d6cc-408c-9b16-06ec63b7d3b4`, store
`i09sb0-6m.myshopify.com`. The imported 2026-09-30 web order
`18915770302596` has null order-level location ID and is fulfilled; no SILO
locations or explicit connection mappings existed. Stored order lines do not
retain location fields, so the mirror cannot prove the raw fulfillment IDs.

After rollout authorization, first re-read the connection and latest watermark.
For prompt rollout while the affected order remains within the incremental
updated-at overlap, dispatch `shopify-sync.yml` at the merged commit with:

- `company_entity_id = 998f69e6-d6cc-408c-9b16-06ec63b7d3b4`
- `connection_id = 11ff0bda-62fc-4bf7-bed5-080d1001e09f`
- `sync_mode = incremental`, `skip_sales = false`
- `skip_inventory = true`, `skip_catalog = true`, `skip_sessions = true`,
  `skip_landing_pages = true`, `skip_discount_codes = true`,
  `collections_enabled = false`

Current main's dispatch can additionally run payouts/draft orders; it has no
strictly sales-only workflow input. This proposed dispatch therefore requires
approval covering those stages as well. The separate sync-splitting change is
still being designed; do not assume or depend on an unpublished stage selector.
Once a verified sales-only input exists, use it with these same company/connection
bounds for the narrowest pilot. `days_back` does **not** override
an existing watermark, and the edge UI does not force yesterday/today like Node.
If the old order has fallen outside the overlap, do not reset all-company state,
run the legacy Better Reports backfill, or claim `days_back` will recover it.
Prepare a separately authorized bounded history replay for only this connection;
review the existing history purge/restart behavior before choosing its range.

This PR did not apply the migration, deploy functions, dispatch a replay, alter
production configuration or merge any branch.
