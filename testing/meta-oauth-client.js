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

  /* Why each permission is asked for, in the customer's terms, shown ON the
   * page beside that permission's live calls. Meta's screencast guide asks for
   * each permission to be annotated, and all five 2026-10-26 rejections said a
   * variant of "we were unable to verify your app reading X" -- a permission
   * name and an endpoint do not say what the app does with the answer. Says
   * the same thing as the per-permission text in
   * docs/ops/public-app-review.md 2.2 / 2.9, in the same terms, but is not
   * byte-pinned to it: the test pins COVERAGE (every permission the probe can
   * report has a line here), not wording. */
  const PERMISSION_PURPOSE = {
    token: 'What this connection\u2019s token actually holds, read before anything that depends on it.',
    ads_read: 'Read-only ad account reporting: SILO reads spend, impressions and clicks per campaign per day for the customer\u2019s marketing reports. SILO never creates or edits campaigns.',
    pages_show_list: 'Lists the Facebook Pages this login may use, so the customer can choose which Page SILO reports on.',
    pages_read_engagement: 'Reads the chosen Page\u2019s identity, follower count and published posts, and issues the Page access token its insights are read with, so organic reporting names the Page the numbers belong to.',
    read_insights: 'Reads the chosen Page\u2019s daily insights and stores them for the customer\u2019s marketing reports.',
    instagram_basic: 'Reads the linked Instagram professional account\u2019s profile and media, so organic reporting can name the account and list its posts.',
    instagram_manage_insights: 'Reads that Instagram account\u2019s account-level and per-post insights \u2014 reach, views, engagement \u2014 so SILO\u2019s organic reporting shows how the customer\u2019s own account and posts performed.',
  };

  /* A line shown under one specific call's result, where the result alone
   * would read as a broken app rather than as evidence. Matched on a fragment
   * of the endpoint the function reports. */
  const CALL_NOTES = [
    {
      match: '/published_posts',
      note: 'This is the Page-content read pages_read_engagement is requested for, and what SILO stores for the customer\u2019s organic reporting. Meta\u2019s response is shown exactly as returned.',
    },
  ];

  const noteForEndpoint = (endpoint) =>
    (CALL_NOTES.find((n) => String(endpoint || '').includes(n.match)) || {}).note || null;

  /** The verify rows as consecutive per-permission groups, each with its
   *  purpose line, so the page can head a section with both. Order is the
   *  function's; grouping never reorders or drops a row. */
  function groupChecks(checks) {
    const groups = [];
    for (const c of checks || []) {
      const last = groups[groups.length - 1];
      if (last && last.permission === c.permission) last.rows.push(c);
      else groups.push({ permission: c.permission, purpose: PERMISSION_PURPOSE[c.permission] || null, rows: [c] });
    }
    return groups;
  }

  root.SiloMetaReviewClient = {
    callFunction, createAssetSession, withBusy, PERMISSION_PURPOSE, CALL_NOTES, noteForEndpoint, groupChecks,
  };
})(typeof window !== 'undefined' ? window : globalThis);
