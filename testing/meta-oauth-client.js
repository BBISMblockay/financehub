/* Request plumbing for the Meta App Review test page, kept apart from the DOM
 * so node can execute it (scripts/tests/meta-oauth-review.test.mjs runs it in
 * a vm sandbox).
 *
 *   callFunction  one edge-function call -> always { status, data }. A fetch
 *                 that REJECTS (offline, CORS, runtime) becomes status 0 with
 *                 data.ok false and the reason, so every caller's existing
 *                 error branch handles it instead of the page hanging.
 *   assetSession  the asset chooser's state: the connection id and the asset
 *                 list travel together, and only the LATEST request's answer
 *                 is accepted. Clicking "Choose assets" for A then B can no
 *                 longer show A's list while saving to B.
 *   withBusy      disables a button (optionally relabels it) for the length of
 *                 an action and always restores it, success or failure.
 *
 * Browser: window.SiloMetaReviewClient. */
(function (root) {
  async function callFunction(fetchImpl, url, init) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      return { status: 0, data: { ok: false, error: `Network error: ${String(err?.message ?? err)}` } };
    }
    const data = await res.json().catch(() => ({ ok: false, error: `Unexpected response (HTTP ${res.status})` }));
    return { status: res.status, data };
  }

  function createAssetSession() {
    let seq = 0;
    let current = null;
    return {
      /** Start a request for connectionId; returns its token. */
      begin(connectionId) {
        seq += 1;
        current = { token: seq, connectionId, data: null };
        return seq;
      },
      /** Keep `data` only if `token` is still the latest request. */
      accept(token, data) {
        if (!current || current.token !== token) return false;
        current.data = data;
        return true;
      },
      isCurrent(token) { return Boolean(current) && current.token === token; },
      /** The connection and the list it was listed for, or null until loaded. */
      active() { return current && current.data ? { token: current.token, connectionId: current.connectionId, data: current.data } : null; },
      /** Forget the chooser; with a token, only if that request is still the latest. */
      clear(token) { if (token === undefined || (current && current.token === token)) current = null; },
    };
  }

  async function withBusy(btn, busyLabel, fn) {
    const orig = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; if (busyLabel) btn.textContent = busyLabel; }
    try {
      return await fn();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  root.SiloMetaReviewClient = { callFunction, createAssetSession, withBusy };
})(typeof window !== 'undefined' ? window : globalThis);
