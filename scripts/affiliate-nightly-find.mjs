// Affiliate Studio's nightly Find (20261125040000).
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

export async function run({ db, log = console.log }) {
  const { data: rows, error } = await db.from('affiliate_studio_spend_settings')
    .select('company_entity_id').eq('nightly_enabled', true).order('company_entity_id').limit(5000);
  if (error) {
    // Not applied yet: nothing is switched on anywhere.
    if (/affiliate_studio_spend_settings|does not exist|PGRST205/i.test(`${error.code} ${error.message}`)) {
      log('Nightly Find: the database update is not applied yet; nothing to run.');
      return { started: 0, failed: 0 };
    }
    throw new Error(`could not read the nightly settings: ${error.message}`);
  }
  let started = 0; let failed = 0;
  for (const { company_entity_id: company } of rows || []) {
    const { data, error: e } = await db.functions.invoke('affiliate-research', { body: { action: 'nightly_scan', company } });
    const status = e?.context?.status ?? (e ? 500 : 202);
    if (!e) {
      started += data?.scan_id && !data?.joined ? 1 : 0;
      log(`${company}: ${data?.skipped ? `skipped (${data.skipped})` : data?.joined ? 'a Find was already running' : 'started'}`);
    } else if (OK_REFUSALS.has(status)) {
      log(`${company}: at its monthly Affiliate Studio cap; not started`);
    } else {
      failed += 1;
      log(`${company}: refused (${status})`);
    }
  }
  log(`Nightly Find: ${started} started, ${failed} refused, ${(rows || []).length} switched on.`);
  return { started, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  run({ db }).then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => { console.error(err.message || err); process.exit(1); });
}
