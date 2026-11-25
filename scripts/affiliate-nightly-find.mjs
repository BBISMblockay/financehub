// Affiliate Studio's nightly Find (20261125040000) and nightly Discovery
// (20261125100000), each switched on separately in Billing.
//
// For every company that turned it on in Workspace Settings → Billing
// (affiliate_studio_spend_settings.nightly_enabled), start ONE Find over its
// top unchecked customers. The edge function does the work, in the background
// and in as many runs as it needs, and stops at the company's own limits:
// customers per night, spend per night, and the monthly cap over all
// Affiliate Studio usage. This script only starts it, one company per call,
// so one company's run never shares another's time or CPU.
//
// It never decides anything about money: every limit is checked by the
// function against the database's own figure (affiliate_studio_spend), and
// every search is metered through the credit RPCs.
//
// Exit 1 when a company's start was refused for a reason SILO can fix, so the
// workflow goes red. A company already running a Find (joined), switched off
// since the list was read (skipped) or at its monthly cap (402) is not a
// failure.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const OK_REFUSALS = new Set([402]);
// A Discovery already running for the program the schedule picked is not a
// failure either: tonight's turn is simply that run.
const OK_DISCOVERY = new Set([402, 429]);

async function readSettings(db) {
  const r = await db.from('affiliate_studio_spend_settings')
    .select('company_entity_id, nightly_enabled, discovery_nightly_enabled')
    .or('nightly_enabled.eq.true,discovery_nightly_enabled.eq.true').order('company_entity_id').limit(5000);
  if (!r.error) return r;
  // Before 20261125100000 there is no Discovery column: keep running Find.
  if (/discovery_nightly_enabled/.test(`${r.error.message}`)) {
    return db.from('affiliate_studio_spend_settings').select('company_entity_id, nightly_enabled')
      .eq('nightly_enabled', true).order('company_entity_id').limit(5000);
  }
  return r;
}

async function start(db, company, action, okRefusals, log, label) {
  const { data, error: e } = await db.functions.invoke('affiliate-research', { body: { action, company } });
  const status = e?.context?.status ?? (e ? 500 : 202);
  if (!e) {
    log(`${company} ${label}: ${data?.skipped ? `skipped (${data.skipped})` : data?.joined ? 'already running' : 'started'}`);
    return { started: data?.scan_id || data?.run_id ? (data?.joined ? 0 : 1) : 0, failed: 0 };
  }
  if (okRefusals.has(status)) {
    log(`${company} ${label}: ${status === 402 ? 'at its monthly Affiliate Studio cap' : 'already running'}; not started`);
    return { started: 0, failed: 0 };
  }
  log(`${company} ${label}: refused (${status})`);
  return { started: 0, failed: 1 };
}

export async function run({ db, log = console.log }) {
  const { data: rows, error } = await readSettings(db);
  if (error) {
    // Not applied yet: nothing is switched on anywhere.
    if (/affiliate_studio_spend_settings|does not exist|PGRST205/i.test(`${error.code} ${error.message}`)) {
      log('Nightly Find: the database update is not applied yet; nothing to run.');
      return { started: 0, failed: 0 };
    }
    throw new Error(`could not read the nightly settings: ${error.message}`);
  }
  let started = 0; let failed = 0;
  for (const row of rows || []) {
    const company = row.company_entity_id;
    const jobs = [];
    if (row.nightly_enabled === true) jobs.push(['nightly_scan', OK_REFUSALS, 'Find']);
    if (row.discovery_nightly_enabled === true) jobs.push(['nightly_discovery', OK_DISCOVERY, 'Discovery']);
    for (const [action, ok, label] of jobs) {
      const r = await start(db, company, action, ok, log, label);
      started += r.started;
      failed += r.failed;
    }
  }
  log(`Nightly Find and Discovery: ${started} started, ${failed} refused, ${(rows || []).length} companies switched on.`);
  return { started, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  run({ db }).then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => { console.error(err.message || err); process.exit(1); });
}
