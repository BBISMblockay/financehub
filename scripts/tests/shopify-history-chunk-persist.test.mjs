// Who wins when two writers touch shopify_connections.meta at once, on the
// UI-driven history import.
//
// The UI import is a chain of HTTP calls to the shopify-sync-run edge
// function: the browser asks for one window, waits minutes for Shopify, asks
// for the next. That function read the row's meta BEFORE the fetch and wrote
// the whole object back after it, so anything written to the row in between
// was erased -- which is why Cancel did nothing: the window it was meant to
// stop put `running` back over it and the import carried on. The scheduled
// incremental sync writes its own watermark keys to the same column, and
// those were rolled back the same way.
//
// planChunkPersist is the decision, pulled out of index.ts so it can be
// executed here: index.ts cannot be imported under Node (Deno specifiers),
// and "which writer wins" is the part worth testing. Raised as a P1 in
// cycle 1 of the review on PR #967, whose first fix covered only the Node
// runner's loop.

import assert from 'node:assert/strict';
import test from 'node:test';
import { planChunkPersist } from '../../supabase/functions/shopify-sync-run/lib/history-chunk-persist.mjs';

const preState = {
  status: 'running', job_id: 'job-1', target_days: 365, chunk_days: 30,
  range_start: '2026-01-01', range_end: '2026-10-13', cursor: '2026-02-01',
  windows_done: 1, windows_total: 10,
};
const nextState = { ...preState, cursor: '2026-03-03', windows_done: 2 };

test('an ordinary window writes its state onto the row as it stands now', () => {
  // The incremental sync wrote a watermark while the window was fetching.
  const stored = {
    history_backfill: preState,
    last_order_sync_at: '2026-10-13T09:00:00Z',
  };
  const plan = planChunkPersist({ preState, storedMeta: stored, nextState, skuMetaJson: { a: 1 } });
  assert.equal(plan.action, 'write');
  assert.equal(plan.cancelled, false);
  assert.equal(plan.meta.last_order_sync_at, '2026-10-13T09:00:00Z',
    'a key written during the window must survive the window');
  assert.deepEqual(plan.meta.history_backfill, nextState);
  assert.deepEqual(plan.meta.history_backfill_caches, { skuMeta: { a: 1 } });
});

test('the sku cache is dropped when the plan finishes', () => {
  const plan = planChunkPersist({
    preState, storedMeta: { history_backfill: preState }, nextState, skuMetaJson: { a: 1 }, done: true,
  });
  assert.equal(plan.meta.history_backfill_caches, null);
});

test('a cancellation that landed during the window stands, and keeps the window', () => {
  const stored = {
    history_backfill: { ...preState, status: 'cancelled', cancelled_at: '2026-10-13T09:05:00Z' },
  };
  const plan = planChunkPersist({ preState, storedMeta: stored, nextState, skuMetaJson: { a: 1 } });
  assert.equal(plan.action, 'write');
  assert.equal(plan.cancelled, true);
  assert.equal(plan.meta.history_backfill.status, 'cancelled',
    'the window must not put `running` back over a cancellation — that is the bug');
  assert.equal(plan.meta.history_backfill.cancelled_at, '2026-10-13T09:05:00Z');
  // The window's rows ARE in sales_by_day, so its progress has to be kept or a
  // resume would re-fetch a window already imported.
  assert.equal(plan.meta.history_backfill.cursor, nextState.cursor);
  assert.equal(plan.meta.history_backfill.windows_done, 2);
  assert.equal(plan.meta.history_backfill_caches, null);
});

test('a window belonging to a replaced import writes nothing at all', () => {
  // Start was pressed again (or the plan was re-planned) while this window ran,
  // which mints a new job id. Writing this window's state would resurrect the
  // plan the operator replaced, cursor and all.
  const replacement = {
    status: 'running', job_id: 'job-2', target_days: 60, chunk_days: 30,
    range_start: '2026-08-14', range_end: '2026-10-13', cursor: '2026-08-14',
    windows_done: 0, windows_total: 2,
  };
  const plan = planChunkPersist({ preState, storedMeta: { history_backfill: replacement }, nextState });
  assert.equal(plan.action, 'superseded');
  assert.equal(plan.meta, null, 'a superseded window must not write');
  assert.deepEqual(plan.state, replacement, 'the caller reports the import that owns the row');
});

test('the same job id is not superseded, and a missing one does not block the write', () => {
  const same = planChunkPersist({
    preState, storedMeta: { history_backfill: { ...preState, job_id: 'job-1' } }, nextState,
  });
  assert.equal(same.action, 'write');

  // The scheduled Node runner creates no job_id. Absent ids cannot prove a
  // replacement, so they must not stop the write.
  const noIds = planChunkPersist({
    preState: { ...preState, job_id: undefined },
    storedMeta: { history_backfill: { ...preState, job_id: undefined } },
    nextState,
  });
  assert.equal(noIds.action, 'write');
});

test('a row whose meta vanished is treated as empty, not as a cancellation', () => {
  for (const storedMeta of [null, undefined, {}, { history_backfill: null }]) {
    const plan = planChunkPersist({ preState, storedMeta, nextState });
    assert.equal(plan.action, 'write', `storedMeta ${JSON.stringify(storedMeta)} must still write`);
    assert.equal(plan.cancelled, false);
    assert.deepEqual(plan.meta.history_backfill, nextState);
  }
});
