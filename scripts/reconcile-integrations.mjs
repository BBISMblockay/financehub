#!/usr/bin/env node
/**
 * scripts/reconcile-integrations.mjs -- the daily "is every client's data
 * actually arriving?" pass.
 *
 * It walks every connection in every company, for every feed in
 * lib/integration-reconcile-core.mjs, and answers three questions per
 * connection: is its authorisation about to expire, has it ever produced
 * anything, and is what it produced recent enough. The judgement lives in
 * that core module so it can be tested; this file is the IO around it.
 *
 * WHAT IT MAY WRITE. Nothing, unless RECONCILE_AUTO_START=true, and then only
 * one thing: an `integration_bootstrap_jobs` row for a connection that has
 * NEVER imported anything and that nobody paused -- the same queue the
 * Integrations page writes to on connect, drained by the same workflow. It
 * never enables a sync, never edits a connection, never touches a client's
 * data. A connection that already has a bootstrap job of any kind, finished
 * or failed, is reported and left alone: re-queueing a failed first import
 * every morning is a paid retry loop on a credential that will never work.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
 *   RECONCILE_AUTO_START      'true' to queue first imports (default off)
 *   RECONCILE_DRY_RUN         'true' to log what it would queue, writing none
 *   RECONCILE_ONLY_FEED       one feed label, for a narrow hand-run
 *   RECONCILE_FAIL_ON_ACTION  'false' to report without failing the run
 */

import { appendFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  INTEGRATION_FEEDS, feedCovers, feedHealthRow, integrationFor, interpretProbe,
  planFirstImport, probeColumn, probeNarrowing, reconcileConnection, reconcileExitCode,
} from './lib/integration-reconcile-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTO_START = process.env.RECONCILE_AUTO_START === 'true';
const DRY_RUN = process.env.RECONCILE_DRY_RUN === 'true';
const ONLY_FEED = process.env.RECONCILE_ONLY_FEED || '';
const FAIL_ON_ACTION = process.env.RECONCILE_FAIL_ON_ACTION !== 'false';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[reconcile] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Today in Pacific, the westernmost bound the rest of the repo reasons in
 *  (scripts/CLAUDE.md). en-CA formats as YYYY-MM-DD. */
function pacificToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** The columns worth reading off a connection table. Selecting `*` would pull
 *  access tokens and refresh tokens into this process and its logs for no
 *  reason, so each table names what the verdict actually needs. */
const CONN_COLUMNS = {
  shopify_connections: 'id, company_entity_id, shop_domain, display_name, is_active, sync_enabled, last_test_status, last_test_success, last_test_error, meta',
  ad_platform_connections: 'id, company_entity_id, platform, display_name, is_active, sync_enabled, last_test_status, last_test_success, last_test_error, meta',
  seo_serp_schedules: 'id, company_entity_id, is_active, last_run_on, note',
  redo_connections: 'id, company_entity_id, display_name, is_active, last_event_at, meta',
  // Deliberately NOT api_key, access_token or refresh_token: this process
  // only needs to know whether the feed is arriving.
  klaviyo_connections: 'id, company_entity_id, display_name, is_active, sync_enabled, last_test_success, last_test_error, last_synced_at, reauth_required_at, meta',
  plaid_connections: 'id, company_entity_id, status, institution_name',
  quickbooks_connections: 'id, company_entity_id, company_name, is_active, refresh_token_expires_at, token_expires_at, meta',
};

/** A label a person can act on: the store, the account, the institution. */
function connLabel(connTable, row) {
  return row.shop_domain || row.display_name || row.institution_name || row.company_name
    || row.platform || `${connTable.replace(/_connections?$/, '')} ${String(row.id).slice(0, 8)}`;
}

async function loadConnections(feed) {
  const cols = CONN_COLUMNS[feed.connTable];
  if (!cols) throw new Error(`no column list for ${feed.connTable}`);
  const { data, error } = await db.from(feed.connTable).select(cols);
  if (error) throw new Error(`${feed.connTable} load failed: ${error.message}`);
  return (data || []).filter((row) => feedCovers(feed, row));
}

/**
 * Has this connection ever produced a row, and what is the newest one?
 *
 * One query answers both, because the newest row existing IS the evidence.
 * interpretProbe in the core turns the answer -- or the error -- into a
 * verdict input.
 */
async function probe(feed, conn) {
  if (!feed.table) return interpretProbe({ feed, connection: conn, row: null, error: null });
  const key = conn[feed.match.connColumn];
  if (key == null) {
    return interpretProbe({ feed, connection: conn, row: null, error: { message: `no ${feed.match.connColumn}` } });
  }
  const order = probeColumn(feed);
  // Scoped to the connection's own company as well as its match key: three
  // storefronts are connected under two companies each, and one company's
  // rows are not evidence about the other's connection.
  const ask = (narrowing) => {
    let q = db.from(feed.table).select(order || 'id')
      .eq(feed.match.dataColumn, key)
      .eq('company_entity_id', conn.company_entity_id);
    if (narrowing) q = q.eq(narrowing.column, narrowing.value);
    q = q.limit(1);
    return order ? q.order(order, { ascending: false }) : q;
  };

  // A narrowed, index-backed ask first where the feed declares one
  // (probeNarrowing). A row found this way is a row this connection
  // produced, so it answers the question outright. Anything else -- no row,
  // or an error -- is NOT an answer and falls through to the full question
  // below, which is what it has always been.
  const narrowing = probeNarrowing(feed);
  if (narrowing) {
    const fast = await ask(narrowing);
    if (!fast.error && (fast.data || [])[0]) {
      return interpretProbe({ feed, connection: conn, row: fast.data[0], error: null });
    }
  }

  const { data, error } = await ask(null);
  return interpretProbe({ feed, connection: conn, row: (data || [])[0] || null, error });
}

/**
 * Queue one first import, exactly once in this connection's lifetime.
 *
 * Returns why it did not, rather than throwing: one connection whose queue
 * row will not land must not stop the pass reporting on the rest.
 */
async function queueFirstImport(feed, conn) {
  const integration = integrationFor(feed, conn);
  if (!integration) return { queued: false, reason: 'no bootstrap plan for this connection' };

  const prior = await db.from('integration_bootstrap_jobs')
    .select('id, status, created_at, last_error')
    .eq('company_entity_id', conn.company_entity_id)
    .eq('integration', integration)
    .eq('connection_id', conn.id)
    .order('created_at', { ascending: false })
    .limit(1);

  const plan = planFirstImport({
    priorJob: (prior.data || [])[0] || null, priorError: prior.error, dryRun: DRY_RUN,
  });
  if (!plan.queue) return { queued: false, reason: plan.reason };

  const { error } = await db.from('integration_bootstrap_jobs').insert({
    company_entity_id: conn.company_entity_id,
    integration,
    connection_id: conn.id,
  });
  // 23505 is the partial unique index on open rows: something queued it
  // between the read above and this insert, which is a success, not a fault.
  if (error && error.code !== '23505') return { queued: false, reason: `insert failed: ${error.message}` };
  return { queued: true, reason: error ? 'already queued' : plan.reason };
}

async function main() {
  const today = pacificToday();
  const feeds = INTEGRATION_FEEDS.filter((f) => !ONLY_FEED || f.label === ONLY_FEED);
  if (!feeds.length) {
    console.error(`[reconcile] no feed called "${ONLY_FEED}"`);
    process.exit(1);
  }

  const rows = [];
  for (const feed of feeds) {
    const connections = await loadConnections(feed);
    // Which identities more than one company holds, for this feed.
    const shared = new Map();
    if (feed.identityColumn) {
      for (const c of connections) {
        const key = c[feed.identityColumn];
        if (key == null) continue;
        if (!shared.has(key)) shared.set(key, new Set());
        shared.get(key).add(c.company_entity_id);
      }
    }
    for (const conn of connections) {
      const duplicate = feed.identityColumn
        ? (shared.get(conn[feed.identityColumn])?.size || 0) > 1
        : false;
      const { everProduced, newestIso, note } = await probe(feed, conn);
      const verdict = reconcileConnection({
        feed, connection: conn, everProduced, newestIso, today, autoStart: AUTO_START, duplicate,
      });
      let action = null;
      let detail = note ? `${verdict.detail} (${note})` : verdict.detail;
      if (verdict.autoStart.start) {
        const result = await queueFirstImport(feed, conn);
        action = result.reason;
        // The queue refusing the row means nobody started anything, so this
        // stays a thing a person has to do -- and the line must say what
        // actually happened, not what the verdict expected to happen.
        if (!result.queued) {
          verdict.autoStart = { start: false, reason: result.reason };
          detail = `connected, never imported, and not started: ${result.reason}`;
        }
      }
      rows.push({ feed, conn, verdict, action, detail, label: connLabel(feed.connTable, conn) });
    }
  }

  report(rows, today);
  await publishHealth(rows, feeds);
  const code = reconcileExitCode(rows.map((r) => r.verdict));
  if (code && FAIL_ON_ACTION) process.exit(code);
  if (code) console.error('[reconcile] RECONCILE_FAIL_ON_ACTION=false — reporting only.');
}

/* Put this pass's verdicts where SILO can show them (integration_feed_health,
 * 20261103220000). Until this existed the whole judgement lived in a workflow
 * log: nothing in the app showed it, no report returned it, and a connected AI
 * could not reach the connection tables at all because they are hidden from the
 * chat catalog. That is how a Plaid feed sat stalled for eight days with every
 * sync green.
 *
 * Deliberate choices:
 *   - It runs AFTER report(), so a write failure can never cost us the log that
 *     is still the primary output, and it never throws: a failed write leaves
 *     yesterday's rows ageing, which the view's `observation_stale` and the
 *     report's second tie-out both announce. Silence is not an option it has.
 *   - Dry run writes nothing, matching what this script promises at the top.
 *   - Pruning deletes only rows for the (company, feed) pairs this run actually
 *     evaluated, and only those stamped before this run -- so a connection that
 *     has gone away stops being reported, while a feed skipped by
 *     RECONCILE_ONLY_FEED, or a company this run never saw, keeps its last
 *     verdict and lets it age honestly.
 */
async function publishHealth(rows, feeds) {
  if (DRY_RUN) {
    console.log(`[reconcile] dry run: would have published ${rows.length} feed-health row(s)`);
    return;
  }
  const observedAt = new Date().toISOString();
  const health = rows.map((r) => feedHealthRow({
    feed: r.feed, connection: r.conn, verdict: r.verdict, detail: r.detail, label: r.label, observedAt,
  })).filter((h) => h.company_entity_id);
  try {
    for (let i = 0; i < health.length; i += 200) {
      const chunk = health.slice(i, i + 200);
      const { error } = await db.from('integration_feed_health')
        .upsert(chunk, { onConflict: 'company_entity_id,feed,connection_id' });
      if (error) throw new Error(error.message);
    }
    const companies = [...new Set(health.map((h) => h.company_entity_id))];
    const labels = feeds.map((f) => f.label);
    if (companies.length && labels.length) {
      const { error } = await db.from('integration_feed_health')
        .delete()
        .in('company_entity_id', companies)
        .in('feed', labels)
        .lt('observed_at', observedAt);
      if (error) throw new Error(error.message);
    }
    console.log(`[reconcile] published ${health.length} feed-health row(s) for ${new Set(health.map((h) => h.company_entity_id)).size} company(ies)`);
  } catch (err) {
    // Not fatal, and not hidden either: the surface will say it is stale.
    console.error(`[reconcile] could not publish feed health: ${err.message} — SILO will show yesterday's verdicts and mark them stale`);
  }
}

const ORDER = { action: 0, warn: 1, ok: 2 };

function report(rows, today) {
  const sorted = [...rows].sort((a, b) =>
    (ORDER[a.verdict.severity] - ORDER[b.verdict.severity]) || a.feed.label.localeCompare(b.feed.label));
  const needing = sorted.filter((r) => r.verdict.severity === 'action' && !r.verdict.autoStart.start);
  const started = sorted.filter((r) => r.verdict.autoStart.start);
  const warned = sorted.filter((r) => r.verdict.severity === 'warn');

  console.log(`[reconcile] Pacific ${today}: ${rows.length} connection(s) across ${new Set(rows.map((r) => r.feed.label)).size} feed(s)`);
  console.log(`[reconcile] ${needing.length} needing a person, ${started.length} first import(s) queued, ${warned.length} warning(s)`);
  for (const r of [...needing, ...warned]) {
    const line = `  [${r.feed.label}] ${r.label} (${r.conn.company_entity_id}): ${r.verdict.state} — ${r.detail}`;
    if (r.verdict.severity === 'action') console.error(line); else console.log(line);
  }
  for (const r of started) {
    console.log(`  [${r.feed.label}] ${r.label}: ${r.action}`);
  }
  if (!AUTO_START) console.log('[reconcile] auto-start is off (RECONCILE_AUTO_START is not "true") — nothing was queued.');

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    `### Integration reconcile — Pacific ${today}`,
    '',
    `${needing.length} needing a person · ${started.length} first import(s) queued · ${warned.length} warning(s) · ${rows.length} connection(s) checked`,
    '',
    '| | Feed | Connection | State | Detail |',
    '| --- | --- | --- | --- | --- |',
  ];
  const mark = { action: '🔴', warn: '🟡', ok: '🟢' };
  for (const r of sorted) {
    if (r.verdict.severity === 'ok' && !r.verdict.autoStart.start) continue;
    const icon = r.verdict.autoStart.start ? '🟦' : mark[r.verdict.severity];
    lines.push(`| ${icon} | ${r.feed.label} | ${esc(r.label)} | ${r.verdict.state} | ${esc(r.action || r.detail)} |`);
  }
  if (lines.length === 6) lines.push('| 🟢 | — | — | ok | every connection is producing within its feed\'s tolerance |');
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

/** A shop domain or an error message must not break the table it sits in. */
function esc(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main().catch((err) => {
  console.error(`[reconcile] pass failed: ${err.message || err}`);
  process.exit(1);
});
