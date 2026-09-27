/* When to retry a model call the provider pushed back on.
 *
 * Why this exists (2026-09-27). Ask SILO is moving from 2-5 users to 10-15.
 * Until now a 429 (rate limited) or 529 (overloaded) from the model API was
 * thrown straight through as "Anthropic API 429: ..." and shown to the person
 * as a raw error -- with a Try again button that fired immediately into the
 * same limit. At a handful of users that almost never happened; at three to
 * five times the traffic, concurrent long investigations are exactly what
 * trips an input-token-per-minute limit.
 *
 * The decision is pure so the tests can walk every branch without a network:
 *   - only transient statuses retry: 429, 500, 502, 503, 504, 529, and a
 *     network failure (status 0). A 400/401/403/404 is the request's fault and
 *     is never retried.
 *   - at most MAX_PROVIDER_RETRIES retries per call.
 *   - the wait honours the provider's `retry-after` (seconds) when present,
 *     capped, and otherwise backs off 1s then 3s plus jitter.
 *   - a retry is refused when the wait plus a working margin would run past
 *     the caller's cap. A retry that cannot finish before the request's own
 *     deadline spends the time the forced-answer path needs, and turns a
 *     recoverable "busy" into an unrecoverable gateway 504 with no audit row.
 *
 * Plain .mjs, shared with the Node test suites like budget-lib.mjs.
 */

export const RETRYABLE_STATUSES = new Set([0, 429, 500, 502, 503, 504, 529]);
/** Statuses that mean "the provider is busy", as opposed to broken. What the
 *  person is told differs: busy is "try again in a minute". */
export const BUSY_STATUSES = new Set([429, 529]);
export const MAX_PROVIDER_RETRIES = 2;
/** A provider asking for longer than this is not waited on inside a request. */
export const MAX_RETRY_WAIT_MS = 15_000;
/** Time that must remain after a wait for the retried call to be worth making. */
export const RETRY_HEADROOM_MS = 10_000;
const BACKOFF_MS = [1_000, 3_000];

/** Error codes that arrive on a transient-looking status but will not clear by
 *  waiting. Anthropic returns a 429 with `enforced_spend_limit_reached` once
 *  the organisation's spend cap is hit: access stays paused until the cap
 *  resets or is raised, so retrying it burns time and telling the person "try
 *  again in a minute" is false (review of #806, cycle 1). */
export const SPEND_LIMIT_CODES = new Set(['enforced_spend_limit_reached']);

/** The provider's machine-readable error code from a response body, or null.
 *  Reads `error.details.error_code` first (where the spend cap is reported),
 *  then `error.type`. Never throws: a body that is not JSON has no code. */
export function providerErrorCode(bodyText) {
  if (!bodyText) return null;
  try {
    const e = JSON.parse(bodyText)?.error;
    const code = e?.details?.error_code ?? e?.type ?? null;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export function isSpendLimit(code) {
  return code != null && SPEND_LIMIT_CODES.has(code);
}

/** `retry-after` is seconds (an integer) or an HTTP date. Returns ms or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @param {{ status: number, retryAfter?: string|null, errorCode?: string|null, attempt: number,
 *           now?: number, capAt?: number, jitter?: () => number }} input
 *   attempt: retries already made for this call (0 on the first failure).
 *   capAt: epoch ms the retried call must be able to finish before; 0 = none.
 * @returns {{ retry: boolean, waitMs: number, reason: string }}
 */
export function retryDecision({ status, retryAfter = null, errorCode = null, attempt, now = Date.now(), capAt = 0, jitter = () => Math.floor(Math.random() * 250) }) {
  if (isSpendLimit(errorCode)) return { retry: false, waitMs: 0, reason: 'spend_limit' };
  if (!RETRYABLE_STATUSES.has(status)) return { retry: false, waitMs: 0, reason: 'not_retryable' };
  if (attempt >= MAX_PROVIDER_RETRIES) return { retry: false, waitMs: 0, reason: 'retries_exhausted' };
  const asked = parseRetryAfter(retryAfter, now);
  if (asked != null && asked > MAX_RETRY_WAIT_MS) return { retry: false, waitMs: 0, reason: 'retry_after_too_long' };
  const waitMs = asked != null ? asked : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] + jitter();
  if (capAt && now + waitMs + RETRY_HEADROOM_MS > capAt) return { retry: false, waitMs: 0, reason: 'no_time_left' };
  return { retry: true, waitMs, reason: 'transient' };
}

/** The usage fields worth keeping from a Messages API response, compactly.
 *  Measurements, never estimates: absent fields stay absent (null). */
export function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cache_read: n(usage.cache_read_input_tokens),
    cache_write: n(usage.cache_creation_input_tokens),
  };
}

/** Totals across a request's calls; a field no call reported stays null. */
export function sumUsage(list) {
  const out = { input: null, output: null, cache_read: null, cache_write: null };
  for (const u of list || []) {
    if (!u) continue;
    for (const k of Object.keys(out)) {
      if (typeof u[k] === 'number') out[k] = (out[k] ?? 0) + u[k];
    }
  }
  return out;
}
