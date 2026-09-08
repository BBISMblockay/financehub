-- Delete the retired Better Reports inventory archive from inventory_on_hand.
--
-- WHAT THIS REMOVES. 3,400,748 rows with source = 'better_reports', written
-- daily between 2026-04-22 and 2026-07-08 by the Google Sheets / Better
-- Reports pipeline. That pipeline was retired on 2026-07-08 (see
-- nightly-silo-sync.yml, manual-only since) and the last row in the table is
-- dated the same day. Nothing has written to that source in two months.
--
-- Measured 2026-09-08, before this ran:
--
--   source            rows        days   first        last
--   better_reports    3,400,748   77     2026-04-22   2026-07-08
--   shopify_api          70,622    1     2026-09-07   2026-09-07
--
--   inventory_on_hand   5,271 MB total  (2,328 MB heap + 2,943 MB indexes)
--   => better_reports is ~94% of the rows and ~4.9 GB of that.
--
-- WHY IT IS SAFE. Nothing reads it:
--   * The only reader of this table is the current-snapshot layer
--     (inventory_on_hand_current_mv -> inventory_on_hand_current_v ->
--     inventory_workboard_v). The matview holds 70,622 rows, exactly the
--     shopify_api count, and ZERO of its rows depend on a better_reports row
--     (verified by anti-join; the guard below re-checks it before deleting).
--   * No page, view, report or edge function queries inventory_on_hand
--     history. silo_chat_schema_catalog already steers Ask SILO away from it
--     ("Prefer this over inventory_on_hand (3.5M+ rows of history) for
--     anything about 'right now'").
--
-- WHY NOT KEEP IT AS HISTORY. Because it is not a history series, it is a
-- stranded fragment, and it can never be joined to a new one:
--   * The Shopify sync that replaced it keeps NO history at all. It calls
--     purgeShopifyInventoryForConnection() and then upserts, so every run
--     deletes the previous snapshot. That was not a decision anyone recorded;
--     it fell out of the purge-and-replace pattern.
--   * Between 2026-07-09 and 2026-09-06 inventory WAS still being synced --
--     2,587 inventory_snapshot sync_jobs -- and every one of those snapshots
--     was overwritten by the next. So the 61-day hole is not missing
--     collection, it is discarded retention.
--   * That hole is unrecoverable. Shopify's Admin API reports only CURRENT
--     inventory levels; there is no historical endpoint to backfill from.
-- So keeping these rows preserves an Apr-Jul island that can never connect to
-- anything. If on-hand history is wanted later, the right build is a small
-- daily rollup going forward, not this.
--
-- WHAT THIS DOES NOT DO. It does not change the snapshot behaviour. The
-- Shopify sync still purges and replaces, and this migration deliberately
-- takes no position on whether that should change -- it only removes an
-- archive from a source that no longer exists.
--
-- RECLAIMING THE DISK. A plain DELETE marks rows dead; it does not return
-- space to the filesystem, and the indexes stay bloated until they are
-- rebuilt. VACUUM FULL cannot run inside a transaction block, so it is NOT in
-- this file. Run it separately, once, after this migration:
--
--     VACUUM (FULL, ANALYZE) public.inventory_on_hand;
--
-- It takes an ACCESS EXCLUSIVE lock for the duration (expect a couple of
-- minutes on ~70k surviving rows), so run it outside the 08:30/14:30 UTC sync
-- windows. pg_repack is the online alternative if the lock is unacceptable.
-- Until it runs, `\dt+` will still report the old size.

begin;

-- ---------------------------------------------------------------------------
-- Guard 1: refuse to run if the live snapshot depends on any of these rows.
-- This is the assertion the whole change rests on, so it is checked here
-- rather than trusted from the analysis above.
-- ---------------------------------------------------------------------------
do $$
declare n bigint;
begin
  select count(*) into n
  from public.inventory_on_hand_current_mv m
  where not exists (
    select 1 from public.inventory_on_hand i
    where i.source = 'shopify_api'
      and i.location_tag = m.location_tag
      and i.variant_sku  = m.variant_sku
  );

  if n > 0 then
    raise exception
      'ABORT: % row(s) in inventory_on_hand_current_mv have no shopify_api row '
      'behind them, so deleting better_reports would change what the inventory '
      'page shows. Investigate before re-running.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Guard 2: refuse to run if something is still writing to this source. If a
-- better_reports row exists that is newer than the retirement date, the
-- premise of this migration ("that pipeline is dead") is wrong.
-- ---------------------------------------------------------------------------
do $$
declare newest date;
begin
  select max(snapshot_at)::date into newest
  from public.inventory_on_hand
  where source = 'better_reports';

  if newest is not null and newest > date '2026-07-08' then
    raise exception
      'ABORT: newest better_reports snapshot is %, after the 2026-07-08 '
      'retirement date. Something is still writing to this source.', newest;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The delete, in batches.
--
-- Batched rather than one statement so the work is bounded and progress is
-- visible; better_reports rows are ~98% of the table, so the inner select
-- finds a full batch immediately and never degenerates into a long scan.
-- Idempotent: a second run finds nothing and exits at once.
-- ---------------------------------------------------------------------------
do $$
declare
  batch    constant int := 50000;
  removed  bigint := 0;
  n        bigint;
begin
  loop
    delete from public.inventory_on_hand
    where id in (
      select id from public.inventory_on_hand
      where source = 'better_reports'
      limit batch
    );
    get diagnostics n = row_count;
    exit when n = 0;
    removed := removed + n;
    raise notice 'deleted % better_reports rows (running total %)', n, removed;
  end loop;

  raise notice 'better_reports inventory archive removed: % row(s)', removed;
end $$;

-- ---------------------------------------------------------------------------
-- Two indexes that exist only to serve sync_batch_id, which nothing queries.
--
-- pg_stat_user_indexes has been accumulating since 2026-06-15 with no reset --
-- a window covering the entire Shopify-sync era, which began 2026-06-23 -- and
-- both show idx_scan = 0 across it. They were 524 MB and 80 MB against the
-- full archive; they are dead weight either way, and every sync run pays to
-- maintain them.
--
-- Deliberately NOT dropped, for the record, because they shrink to a couple of
-- MB once the rows above are gone and each has a reason to exist:
--   inventory_on_hand_current_lookup_idx    514 MB, 7 scans -- fossil of the
--       pre-matview inventory_on_hand_current_v; harmless once small
--   inventory_on_hand_loc_sku_snapshot_idx  341 MB, 4 scans
--   inventory_on_hand_product_title_trgm_idx 250 MB, 3 scans -- Ask SILO
--       substring search, added deliberately in 20260820140000 and asserted
--       in verify_v2_schema.sql
--   inventory_on_hand_variant_sku_trgm_idx  235 MB, 0 scans -- same pair as
--       above; dropping half of a deliberate pair to save ~5 MB post-delete
--       would break a documented check for nothing
-- ---------------------------------------------------------------------------
drop index if exists public.inventory_on_hand_loc_sku_batch_idx;
drop index if exists public.inventory_on_hand_batch_idx;

-- Refresh planner statistics against the much smaller table. (This is ANALYZE,
-- not VACUUM FULL -- see the header for reclaiming disk.)
analyze public.inventory_on_hand;

commit;
