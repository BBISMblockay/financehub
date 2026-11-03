// Nightly Windsor.ai sync (GitHub Actions: .github/workflows/windsor-sync.yml).
// Logic: scripts/lib/windsor-sync-core.mjs. For every Windsor account the
// windsor-broker has attributed to a company, pull its data into SILO's
// tables under that company. One sync_jobs row per company per run.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   WINDSOR_API_KEY                            required (repo secret; same key as the edge secret)
//   WINDSOR_ONLY_COMPANY_ID                    optional, one company
//   WINDSOR_HISTORY_MONTHS                     optional, how far back history goes (default 24)
//   WINDSOR_MAX_HISTORY_WINDOWS                optional, history months walked per account per run (default 6)
//   WINDSOR_MAX_CALLS                          optional, Windsor calls this run may make (default 3000;
//                                              Windsor allows 10,000 a day)
//   WINDSOR_DRY_RUN=true                       read and report shapes, write nothing
//
// Exit code: 1 when any account ended in 'error' (something SILO or Windsor
// must fix), 0 otherwise. 'partial' (budget reached, or Windsor refused some
// fields) is reported, not failed: the next run continues.

import { createClient } from '@supabase/supabase-js';
import {
  syncAccount, WINDSOR_SYNC_JOB_TYPE, DEFAULT_HISTORY_MONTHS,
} from './lib/windsor-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY = process.env.WINDSOR_API_KEY || '';
const ONLY_COMPANY_ID = process.env.WINDSOR_ONLY_COMPANY_ID || '';
const intEnv = (name, dflt) => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const HISTORY_MONTHS = intEnv('WINDSOR_HISTORY_MONTHS', DEFAULT_HISTORY_MONTHS);
const MAX_HISTORY_WINDOWS = intEnv('WINDSOR_MAX_HISTORY_WINDOWS', 6);
const MAX_CALLS = intEnv('WINDSOR_MAX_CALLS', 3000);
const DRY_RUN = String(process.env.WINDSOR_DRY_RUN || '').toLowerCase() === 'true';
const BATCH_ID = `windsor-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!KEY) {
  console.error('WINDSOR_API_KEY is not set. Add it under Settings -> Secrets and variables -> Actions.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 20261103080000 (any connector) may be merged before it is applied. Until it
// is, run exactly as before it: hand-made connectors only, no refused_fields
// bookkeeping, no mappings. Probed, not assumed.
const { error: anyErr } = await supabase.from('windsor_field_mappings').select('id').limit(1);
const anyConnector = !anyErr;
if (!anyConnector) console.log(`Any-connector tables not found (${anyErr.message}); only TikTok and Klaviyo run until 20261103080000 is applied.`);

let q = supabase.from('windsor_linked_accounts')
  .select(`id, company_entity_id, ds_id, account_id, account_name, history_from, sync_enabled${anyConnector ? ', mapping_generation' : ''}`)
  .order('company_entity_id').order('ds_id').order('account_id');
if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
const { data: accounts, error } = await q;
if (error) throw new Error(`could not read Windsor sync consent (apply the sync consent migration first): ${error.message}`);

console.log(`${accounts.length} Windsor account(s); history ${HISTORY_MONTHS} months, `
  + `${MAX_HISTORY_WINDOWS} history window(s) per account, ${MAX_CALLS} call budget${DRY_RUN ? ', DRY RUN' : ''}`);

// Each company's own field choices (windsor_field_mappings), by company and
// data source: { measure: field_id | null }.
let mappingRows = [];
if (anyConnector) {
  const { data, error: mapErr } = await supabase.from('windsor_field_mappings')
    .select('company_entity_id, ds_id, measure, field_id');
  if (mapErr) throw new Error(`could not read windsor_field_mappings: ${mapErr.message}`);
  mappingRows = data ?? [];
}
const overridesFor = (companyId, dsId) => {
  const out = {};
  for (const m of mappingRows) if (m.company_entity_id === companyId && m.ds_id === dsId) out[m.measure] = m.field_id;
  return out;
};

const byCompany = new Map();
for (const a of accounts) {
  if (!byCompany.has(a.company_entity_id)) byCompany.set(a.company_entity_id, []);
  byCompany.get(a.company_entity_id).push(a);
}

const counter = { used: 0, limit: MAX_CALLS };
// Windsor's field list per connector, read once for the whole run.
const catalogCache = new Map();
let failed = 0;
for (const [companyId, list] of byCompany) {
  let jobId = null;
  if (!DRY_RUN) {
    const { data: job, error: jobErr } = await supabase.from('sync_jobs')
      .insert({ company_entity_id: companyId, job_type: WINDSOR_SYNC_JOB_TYPE, status: 'running', started_at: new Date().toISOString(),
        params: { history_months: HISTORY_MONTHS, max_history_windows: MAX_HISTORY_WINDOWS, batch_id: BATCH_ID } })
      .select('id').single();
    if (jobErr) throw new Error(`sync_jobs insert failed: ${jobErr.message}`);
    jobId = job.id;
  }
  const results = [];
  for (const account of list) {
    const r = await syncAccount({
      supabase, fetchImpl: fetch, key: KEY, account, historyMonths: HISTORY_MONTHS,
      maxHistoryWindows: MAX_HISTORY_WINDOWS, counter, batchId: BATCH_ID, dryRun: DRY_RUN, log: console.log,
      catalogCache, overrides: overridesFor(companyId, account.ds_id), anyConnector,
    });
    results.push(r);
    console.log(`${companyId} ${r.ds_id} ${r.account_id}: ${r.status}, ${r.rows_written} rows`
      + `${r.mapped_to ? ` (auto-mapped to ${r.mapped_to})` : ''}`
      + `${r.refused_fields?.length ? `, ${r.refused_fields.length} hunted field(s) not returned by Windsor` : ''}`
      + `${r.ignored_mappings?.length ? `, mapping ignored for ${r.ignored_mappings.join(', ')} (field not offered by Windsor)` : ''}`
      + `${r.history_from ? `, history from ${r.history_from}${r.history_complete ? ' (complete)' : ''}` : ''}`
      + `${r.dropped_fields.length ? `, Windsor refused ${r.dropped_fields.join(', ')}` : ''}${r.error ? `, ${r.error}` : ''}`);
    if (DRY_RUN) console.log(JSON.stringify(r.windows, null, 2));
  }
  const errors = results.filter((r) => r.status === 'error');
  failed += errors.length;
  if (jobId) {
    const status = errors.length ? 'error' : 'success';
    await supabase.from('sync_jobs').update({
      status, finished_at: new Date().toISOString(),
      result: { accounts: results.map(({ windows, refused_fields, ...rest }) => ({ ...rest, refused_count: refused_fields?.length ?? 0 })),
        windsor_calls_used: counter.used },
      error: errors.length ? errors.map((r) => `${r.ds_id} ${r.account_id}: ${r.error}`).join('; ').slice(0, 1000) : null,
    }).eq('id', jobId);
  }
}

console.log(`Windsor calls used: ${counter.used} of ${MAX_CALLS}`);
if (failed) {
  console.error(`${failed} account(s) failed`);
  process.exit(1);
}
