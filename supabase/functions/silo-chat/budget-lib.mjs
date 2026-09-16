// supabase/functions/silo-chat/budget-lib.mjs
//
// The time arithmetic behind the correction round, kept OUT of index.ts so it
// can be executed exactly -- same reason as seo-lib.mjs and evidence-scope.mjs.
//
// It lives here because it was got wrong twice in ways an integration test
// could not pin. A fixed 115s cutoff overshot the 150s gateway by 7s at the
// measured 17.1s per model call; replacing it with a reservation then set the
// floor so high that a grant became arithmetically impossible. Both are
// one-line mistakes in a formula, and a handler test that drives real elapsed
// time can only reach the boundary to within a millisecond or two of drift --
// which is exactly where these mistakes live. Here the numbers are inputs.

/** Supabase's edge gateway kills a request at 150s and returns a bare 504 that
 *  writes no audit row, so the failure is invisible. 140s leaves 10s of margin
 *  for everything this arithmetic does not model. */
export const GATEWAY_SAFE_MS = 140_000;

/** A floor on the per-call estimate, applied EVEN WHEN real samples exist, so a
 *  request that has been cheap so far is still held to a pessimistic figure.
 *
 *  The value is load-bearing rather than round. A grant only happens at or past
 *  the 95s round-start budget, so one is possible only while
 *  95 + 2*worstCall + 10 <= 140, i.e. worstCall <= 17.5s. Setting this to 20s
 *  made a grant impossible; the window it leaves is genuinely narrow, and that
 *  is the shape of the constraint rather than a conservatism to tune away. */
export const MODEL_CALL_FLOOR_MS = 15_000;

/** A query cannot outlive the caller's statement_timeout, measured at ~8s
 *  (docs/ops/bugs.md -- the 30s the RPC declares has never governed). Rounded
 *  up, because being wrong in this direction costs the whole answer. */
export const QUERY_CEILING_MS = 10_000;

/**
 * Does one correction round still fit before the gateway closes?
 *
 * A correction costs a model call, then the query, then the forced final
 * answer's OWN model call. All three are reserved: dropping the last one is the
 * mistake that produced a 157s worst case.
 *
 * The estimate is measured from this request's own calls, because the wall
 * clock here is spent on model latency and not in the database -- on the traced
 * Sonic request, 119,656ms of model time against 18,331ms of queries. A
 * constant cannot know how expensive the current request's rounds have been.
 */
export function correctionRoundFits({
  elapsedMs,
  modelCallMs = [],
  floorMs = MODEL_CALL_FLOOR_MS,
  queryCeilingMs = QUERY_CEILING_MS,
  gatewaySafeMs = GATEWAY_SAFE_MS,
} = {}) {
  const worstCall = Math.max(floorMs, ...modelCallMs);
  return elapsedMs + worstCall * 2 + queryCeilingMs <= gatewaySafeMs;
}

/** The cheapest forced final answer worth reserving for. Below this the model
 *  has no room to write even a short partial, so a correction that would leave
 *  less than this is not worth granting -- the request would reach the gateway
 *  having spent its last round on a query nobody gets told about. */
export const MIN_FINAL_CALL_MS = 12_000;

/**
 * How long THIS model call may take, as an absolute deadline rather than a
 * prediction.
 *
 * correctionRoundFits above is an ADMISSION check: it decides, from what
 * earlier rounds cost, whether a correction is worth starting. It cannot be the
 * enforcement boundary, because it reasons about calls that have not happened
 * yet -- two future calls at 25s each are ordinary latency variation, not a
 * code error, and they overshoot a grant admitted on 15s samples by enough to
 * reach the gateway. The fetch then has no timeout of its own, so the request
 * is killed with no answer and no audit row.
 *
 * So the admission check stays, and this draws the line it cannot: what remains
 * before the safe deadline, minus whatever must still happen afterwards.
 * `reserveMs` is that remainder -- for a correction round, the query it will run
 * plus the forced final that reports it; for the forced final itself, nothing.
 *
 * Returns 0 when the deadline has already passed, which callers read as "do not
 * start this call".
 */
export function modelCallTimeoutMs({
  elapsedMs,
  reserveMs = 0,
  hardDeadlineMs = GATEWAY_SAFE_MS,
} = {}) {
  return Math.max(0, hardDeadlineMs - elapsedMs - reserveMs);
}
