/* v2/integration-bootstrap.js -- the browser half of first-connect auto sync.
 *
 * Two jobs, and deliberately nothing else:
 *   1. enqueue()  -- on connect, write one integration_bootstrap_jobs row, so
 *      the server finishes the first full sync whether or not the person
 *      stays on the page.
 *   2. describe() -- turn that row into one line the Integrations page can
 *      show, so "setting up, 4 of 9" replaces "Keep this tab open".
 *
 * The immediate half is NOT here: the page keeps calling the per-connection
 * sync functions it already called, right after enqueueing, so numbers appear
 * while somebody is still looking at the screen. The queue is what makes the
 * rest land. Both halves are needed -- GitHub's schedules on this repo arrive
 * late and in bursts, and an edge function cannot hold a 60-day import open.
 *
 * STAGES is a LABEL table, not a plan. The plan lives in
 * scripts/lib/integration-bootstrap-core.mjs (BOOTSTRAP_PLANS) and is what
 * the drainer executes; this copy exists only so the page can say how many
 * stages to expect before the drainer has recorded any. The two are pinned
 * together by scripts/tests/integration-bootstrap.test.mjs, which fails if a
 * stage is added to one and not the other -- a drifted label would quietly
 * report a job complete at "7 of 7" while two stages were still owed.
 */
(function () {
  const STAGES = {
    shopify: [
      ['sales_history', 'order history'],
      ['storefront', 'products, stock and analytics'],
    ],
    google_ads: [['kpis', 'daily performance']],
    ga4: [['kpis', 'daily traffic']],
    meta_ads: [['kpis', 'daily performance']],
    tiktok_ads: [['kpis', 'daily performance']],
    search_console: [['backfill', 'search history']],
    redo: [
      ['returns_backfill', 'past returns'],
      ['marketing', 'campaign reporting'],
    ],
  };

  const LABEL = {
    shopify: 'Shopify',
    google_ads: 'Google Ads',
    ga4: 'GA4',
    meta_ads: 'Meta',
    tiktok_ads: 'TikTok',
    search_console: 'Search Console',
    redo: 'Redo',
  };

  /** Queue the first full sync for a connection that was just saved.
   *
   * Returns { queued, already, error }. An `already` is a SUCCESS: the
   * partial unique index on (company, integration, connection) for open rows
   * is what stops a double-click, a reconnect or a retried insert from
   * queueing the same work twice, and the page must not report that as a
   * failure. Nothing here throws -- a connection that worked must not look
   * broken because its bookkeeping row did not land.
   */
  async function enqueue(db, { companyId, integration, connectionId = null }) {
    if (!db || !companyId || !integration) {
      return { queued: false, already: false, error: 'missing company or integration' };
    }
    if (!STAGES[integration]) {
      return { queued: false, already: false, error: `unknown integration "${integration}"` };
    }
    const { error } = await db.from('integration_bootstrap_jobs').insert({
      company_entity_id: companyId,
      integration,
      connection_id: connectionId,
    });
    if (!error) return { queued: true, already: false, error: null };
    // 23505 is the unique violation: an open job already covers this.
    if (error.code === '23505') return { queued: false, already: true, error: null };
    return { queued: false, already: false, error: error.message };
  }

  /** The newest job for one connection, or null.
   *
   * Used instead of a bare "has one" where the ANSWER depends on what the
   * last one did: a Redo connection made without an API secret finishes with
   * both its stages recorded skipped, and pasting the secret afterwards is
   * exactly when the catch-up becomes possible. Queueing on "no job exists"
   * would never queue that one; queueing unconditionally would re-import on
   * every re-paste.
   */
  async function latest(db, { companyId, integration, connectionId = null }) {
    if (!db || !companyId || !integration) return null;
    let q = db.from('integration_bootstrap_jobs')
      .select('id, integration, connection_id, status, stages, attempts, last_error, created_at, finished_at')
      .eq('company_entity_id', companyId)
      .eq('integration', integration)
      .order('created_at', { ascending: false })
      .limit(1);
    q = connectionId ? q.eq('connection_id', connectionId) : q.is('connection_id', null);
    const { data, error } = await q;
    // A read error is reported AS an error, never as a job. Answering "a job
    // exists" would make the caller skip the insert and say nothing, and the
    // most likely read error is the one this feature ships with: the
    // migration is not applied yet, so the table does not exist (42P01).
    // Somebody connecting a store in that window would be told the
    // connection worked and never told that nothing was set up. What stops a
    // duplicate import is the partial unique index in the database, not this
    // read.
    if (error) return { error: error.message || String(error), code: error.code || null };
    return (data || [])[0] || null;
  }

  /** Did this job finish with a stage it could not run? */
  function wasSkipped(job) {
    return Object.values((job && job.stages) || {}).some((v) => v?.status === 'skipped');
  }

  /** The open and recently finished jobs for the active company. */
  async function load(db, companyId) {
    if (!db || !companyId) return [];
    const { data, error } = await db
      .from('integration_bootstrap_jobs')
      .select('id, integration, connection_id, status, stages, attempts, last_error, created_at, finished_at')
      .eq('company_entity_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return [];
    return data || [];
  }

  /** The job covering one connection, or null. Redo has one row per company
   * and no connection id, so it is matched on the integration alone. */
  function forConnection(jobs, integration, connectionId) {
    return (jobs || []).find((j) => j.integration === integration
      && (connectionId ? j.connection_id === connectionId : !j.connection_id)) || null;
  }

  /** One line for the row: what is happening, and what is left.
   *
   * A stage recorded `skipped` counts as finished, because it is: Redo
   * without an API secret cannot import past returns, and reporting that as
   * "1 of 2, stuck" would send someone looking for a fault that is really a
   * missing credential. The reason travels in `detail` and is shown.
   */
  function describe(job) {
    if (!job) return null;
    const stages = STAGES[job.integration] || [];
    const recorded = job.stages || {};
    const finished = stages.filter(([k]) => ['done', 'skipped'].includes(recorded[k]?.status));
    const running = stages.find(([k]) => recorded[k]?.status === 'running');
    const errored = stages.filter(([k]) => recorded[k]?.status === 'error');
    const name = LABEL[job.integration] || job.integration;
    const of = `${finished.length} of ${stages.length}`;

    if (job.status === 'cancelled') {
      return { tone: 'warn', text: `${name} first sync stopped — ${job.last_error || 'cancelled'}` };
    }
    if (job.status === 'done') {
      const skipped = stages.filter(([k]) => recorded[k]?.status === 'skipped');
      if (skipped.length) {
        return {
          tone: 'warn',
          text: `${name} set up — ${skipped.map(([, l]) => l).join(' and ')} not imported (${recorded[skipped[0][0]]?.detail || 'prerequisite missing'})`,
        };
      }
      return { tone: 'pos', text: `${name} first sync complete` };
    }
    if (job.status === 'error') {
      return {
        tone: 'neg',
        text: `${name} first sync failed after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'} — ${job.last_error || 'see the sync log'}`,
      };
    }
    if (job.status === 'partial') {
      return {
        tone: 'warn',
        text: `${name} partly set up (${of}) — ${errored.map(([, l]) => l).join(', ')} did not import`,
      };
    }
    if (running) {
      return { tone: 'info', text: `${name}: importing ${running[1]} (${of})` };
    }
    // Queued, and nothing claimed yet. Saying "shortly" rather than a time is
    // deliberate: the drainer is a scheduled runner and this page cannot know
    // when it will pick the row up.
    return { tone: 'info', text: `${name} first sync queued (${of}) — it runs on the server, you can close this page` };
  }

  window.SiloBootstrap = { STAGES, LABEL, enqueue, latest, wasSkipped, load, forConnection, describe };
})();
