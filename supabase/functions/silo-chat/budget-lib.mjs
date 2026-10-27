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

/** The line no request may cross. It was 140s under Supabase's 150s gateway
 *  (a bare 504, no audit row). Since 2026-09-28 the response starts early and
 *  heartbeats (keepalive-lib.mjs), so the bound is the worker's own wall clock
 *  -- 400s on this project's Pro plan -- and the margin below it is wide
 *  because a request may land on a worker that has already been running.
 *  RAISED 2026-10-27 from 260s to the largest value the margin invariant in
 *  handler.test.mjs admits (WORKER_WALL_CLOCK_MS - 100s): four live MCA
 *  underwriting questions spent 270-285s and were cut off with nothing. The
 *  45s window above WALL_CLOCK_BUDGET_MS that the correction arithmetic is
 *  tuned against is unchanged -- index.ts's budget moved by the same 40s. */
export const GATEWAY_SAFE_MS = 300_000;

/** The hard ceiling GATEWAY_SAFE_MS must stay under: the edge worker's wall
 *  clock on a paid plan. */
export const WORKER_WALL_CLOCK_MS = 400_000;

/** A floor on the per-call estimate, applied EVEN WHEN real samples exist, so a
 *  request that has been cheap so far is still held to a pessimistic figure.
 *
 *  The value is load-bearing rather than round. A grant only happens at or past
 *  the 215s round-start budget, so one is possible only while
 *  215 + 2*worstCall + 10 <= 260, i.e. worstCall <= 17.5s. Setting this to 20s
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

/** What an ORDINARY round must leave behind it, and why ordinary rounds are
 *  bounded at all now.
 *
 *  Until 2026-10-27 only post-budget calls (a granted correction, the forced
 *  final) carried a deadline. The loop checked the clock BEFORE starting a
 *  round and never again, so a round admitted at 214s could spend a slow model
 *  call and two queries and arrive at the forced final with the safe line
 *  already behind it. That is not a hypothetical: it is what every one of the
 *  four MCA underwriting requests of 2026-10-27 did (05:42, 05:47, 05:58,
 *  06:03 UTC). Each reached `finalCallDeadline` with 0ms left, each threw
 *  `ModelCallDeadlineError: ... 0ms deadline`, and each threw away 9-18
 *  completed queries to show the user a bare "ran out of time" message.
 *
 *  So a round's model call now reserves what still has to happen after it: the
 *  queries that round is about to run, plus the forced final that reports them.
 *  TWO query ceilings, not one -- a round issues as many tool calls as the
 *  model asked for, and they run one after another (18 queries across 12
 *  rounds on the 05:42 request). Two is the observed shape, not a proof; the
 *  floor under the forced final (finalAnswerTimeoutMs) is what holds when a
 *  round runs more. */
export const ROUND_RESERVE_MS = 2 * QUERY_CEILING_MS + MIN_FINAL_CALL_MS;

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

/**
 * How long the FORCED FINAL ANSWER may take.
 *
 * Not modelCallTimeoutMs: that returns 0 when the deadline has passed, and
 * callers read 0 as "do not start this call". For every other call that is
 * right. For this one it is the bug above -- the call that is refused is the
 * only one that can turn an investigation into an answer, and refusing it is
 * how a request with 18 good queries in hand ends as an error.
 *
 * So this never returns 0. Past the safe line it returns the floor, which is
 * deliberately spent from the margin BELOW the worker's wall clock rather than
 * from the budget above it: GATEWAY_SAFE_MS keeps 100s of room under
 * WORKER_WALL_CLOCK_MS, and a floor of MIN_FINAL_CALL_MS plus the audit write
 * is a small bite out of it. A worker killed mid-call still writes nothing --
 * that has not changed -- but reaching it now takes an overrun 100s deep
 * instead of a round that merely finished late.
 */
export function finalAnswerTimeoutMs({
  elapsedMs,
  hardDeadlineMs = GATEWAY_SAFE_MS,
  floorMs = MIN_FINAL_CALL_MS,
} = {}) {
  return Math.max(floorMs, hardDeadlineMs - elapsedMs);
}
