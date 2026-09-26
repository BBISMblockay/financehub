// scripts/seo-serp-sync.mjs -- weekly DataForSEO SERP fetch for every company
// whose seo_serp_schedules row is active. Logic lives in
// scripts/lib/seo-serp-sync-core.mjs (syncSerpSchedule); this file only loads
// schedules, reads the credentials, and sets the exit code.
//
// Weekly (seo-serp-sync.yml) with a same-day catch-up: the second run RESUMES
// any run whose collection hit the deadline (posting nothing) and no-ops on a
// completed one, so a dropped scheduled run costs a week, never a double
// spend.
//
// Credentials: DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD, SILO-owned repo
// secrets (HTTP Basic), one key for every tenant -- the
// GOOGLE_ADS_DEVELOPER_TOKEN precedent. Per-company bounds live on the
// schedule row, never in env.

import { createClient } from '@supabase/supabase-js';
import { syncSerpSchedule } from './lib/seo-serp-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
const credentials = { login: process.env.DATAFORSEO_LOGIN || '', password: process.env.DATAFORSEO_PASSWORD || '' };
if (!credentials.login || !credentials.password) throw new Error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');

const ONLY_COMPANY_ID = process.env.SEO_SERP_COMPANY_ID || '';
const COLLECT_WAIT_MS = Number(process.env.SEO_SERP_COLLECT_WAIT_MINUTES || 20) * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  let q = supabase.from('seo_serp_schedules').select('*').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  const { data: schedules, error } = await q;
  if (error) throw new Error(`seo_serp_schedules load failed: ${error.message}`);
  if (!schedules?.length) { console.log('[seo-serp] no active seo_serp_schedules'); return; }

  let failed = false;
  for (const schedule of schedules) {
    try {
      const out = await syncSerpSchedule({ supabase, schedule, credentials, collectWaitMs: COLLECT_WAIT_MS, log: console.log });
      const pending = (out.devices || []).reduce((s, d) => s + (d.pending || 0), 0);
      console.log(`[seo-serp] ${schedule.company_entity_id}: ${out.skipped ? `skipped (${out.skipped})` : `${out.observed_on} ${out.keywords} keywords, ${pending} task(s) still pending`}`);
    } catch (err) {
      failed = true;
      console.error(`[error] ${schedule.company_entity_id}: ${err?.message || err}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => { console.error('[seo-serp] fatal', err); process.exit(1); });
