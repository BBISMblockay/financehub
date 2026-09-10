/* One call to the Supabase Management API's query endpoint, with the
 * throttling handled.
 *
 * The endpoint is rate-limited (it answers HTTP 429 "ThrottlerException").
 * The second live run of deployment-drift-check.yml sent 148 statements as
 * fast as they returned and lost the last 28 to that -- a red run that said
 * "could not run", which is not a finding about the database. So two
 * things: a minimum spacing between calls, and on 429 a wait (Retry-After
 * when the API sends one, else a doubling backoff) and a retry.
 *
 * Pure apart from what is injected: `fetch` and `sleep` are parameters so
 * the retry shape is testable without a network.
 */

export const DEFAULT_MIN_GAP_MS = 700;   // ~85/min, under the observed limit
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BASE_BACKOFF_MS = 4000;

/**
 * @returns {Promise<{ rows?: unknown, error?: string, retries: number }>}
 */
export async function queryWithRetry(opts) {
  const {
    fetch: fetchImpl, sleep, token, ref, query,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    log = () => {},
  } = opts;
  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  let retries = 0;
  for (;;) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const raw = await res.text();
    if (res.status === 429 && retries < maxRetries) {
      const hinted = Number(res.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(hinted) && hinted > 0
        ? hinted * 1000
        : baseBackoffMs * 2 ** retries;
      retries++;
      log(`  (rate limited; waiting ${Math.round(waitMs / 1000)}s, retry ${retries}/${maxRetries})`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) return { error: `HTTP ${res.status}: ${raw.slice(0, 300)}`, retries };
    try { return { rows: JSON.parse(raw), retries }; }
    catch { return { error: `unparseable response: ${raw.slice(0, 200)}`, retries }; }
  }
}

/** Spaces calls at least `minGapMs` apart. Returns a function that resolves
 * once it is this call's turn. */
export function makePacer(minGapMs, sleep, now = () => Date.now()) {
  let last = -Infinity;
  return async () => {
    const wait = last + minGapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };
}
