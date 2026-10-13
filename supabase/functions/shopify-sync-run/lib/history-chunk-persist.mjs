// What to write to shopify_connections.meta after a UI-driven history window
// finishes, and when to write nothing at all.
//
// The UI import is a chain of HTTP calls: the browser asks the edge function
// for one window, waits minutes for Shopify, and asks for the next. The
// function used to read the row's meta BEFORE the fetch and write the whole
// object back after it, so anything written to that row in between was
// erased. Two things write to it: the Cancel action (which sets
// history_backfill.status = 'cancelled'), and the scheduled incremental sync
// (which writes its watermark keys). So Cancel was undone by the window it
// was meant to stop, and a watermark could be rolled back by a window that
// started before it.
//
// Re-reading the row and merging onto what is actually stored closes both.
// What a re-read alone cannot close is the gap between the read and the write:
// a cancel landing in those milliseconds is still lost. The job id is the
// cheap guard for the case that matters -- pressing Start again, or
// re-planning, mints a new job id, and a window still running under the old
// one must not resurrect the plan the operator replaced.
//
// Kept as a pure function in its own module, both because index.ts cannot be
// imported under Node (Deno specifiers) and because the question it answers --
// which of two concurrent writers wins -- is the one worth having tests for.

/**
 * @param {object}  args
 * @param {object}  args.preState    history_backfill as it was BEFORE the window ran
 * @param {object}  args.storedMeta  the row's meta, re-read AFTER the window ran
 * @param {object}  args.nextState   history_backfill the window produced
 * @param {*}       args.skuMetaJson serialized sku cache, or null
 * @param {boolean} args.done        the window plan is finished
 * @returns {{ action: 'write'|'superseded', cancelled: boolean, meta: object|null, state: object }}
 */
export function planChunkPersist({ preState, storedMeta, nextState, skuMetaJson = null, done = false }) {
  const stored = storedMeta && typeof storedMeta === 'object' ? storedMeta : {};
  const storedState = stored.history_backfill && typeof stored.history_backfill === 'object'
    ? stored.history_backfill
    : null;

  const preJob = preState?.job_id ?? null;
  const storedJob = storedState?.job_id ?? null;

  // Another import owns this connection now. Write nothing: the row already
  // describes the run the operator wants, and this window's state describes
  // one they replaced.
  if (preJob && storedJob && storedJob !== preJob) {
    return { action: 'superseded', cancelled: false, meta: null, state: storedState };
  }

  // Cancelled while this window was fetching. The window's rows ARE in the
  // table, so its progress has to be kept -- the cursor must not point at a
  // window already imported -- but the status stays cancelled.
  if (storedState?.status === 'cancelled') {
    const state = {
      ...nextState,
      status: 'cancelled',
      ...(storedState.cancelled_at ? { cancelled_at: storedState.cancelled_at } : {}),
    };
    return {
      action: 'write',
      cancelled: true,
      meta: { ...stored, history_backfill: state, history_backfill_caches: null },
      state,
    };
  }

  return {
    action: 'write',
    cancelled: false,
    meta: {
      ...stored,
      history_backfill: nextState,
      history_backfill_caches: done ? null : (skuMetaJson ? { skuMeta: skuMetaJson } : null),
    },
    state: nextState,
  };
}

/**
 * May this request run a window at all?
 *
 * handleHistoryChunk took the job id the BROWSER sent and used it for status
 * updates without checking it against the plan on the row. After job 1 was
 * replaced by job 2 (a re-Start, or a replan), a delayed request still
 * carrying job 1 would advance job 2's cursor and purge and rebuild job 2's
 * window, while reporting progress against job 1 -- so two tabs could process
 * the same window at once and the live job could sit at `running` while its
 * data moved underneath it. The check belongs BEFORE any side effect, which
 * is why it is not folded into planChunkPersist: by the time that runs, the
 * window has already been fetched and written.
 *
 * A request with no job id is the UI's first call, before an id exists, and a
 * stored plan with no job id is the scheduled runner's; neither can be shown
 * to be stale, so neither is refused.
 *
 * @returns {{ ok: true, jobId: string|null } | { ok: false, reason: 'superseded', jobId: string|null }}
 */
export function chunkRequestVerdict({ suppliedJobId = null, state = null } = {}) {
  const storedJob = state?.job_id ?? null;
  if (suppliedJobId && storedJob && suppliedJobId !== storedJob) {
    return { ok: false, reason: 'superseded', jobId: storedJob };
  }
  // The stored plan's id wins: it is the one the row agrees with.
  return { ok: true, jobId: storedJob ?? suppliedJobId ?? null };
}
