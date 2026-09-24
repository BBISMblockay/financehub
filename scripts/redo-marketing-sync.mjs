// scripts/redo-marketing-sync.mjs -- Redo campaign + automation reporting
// into redo_marketing_messages / redo_marketing_daily. Logic lives in
// scripts/lib/redo-marketing-sync-core.mjs (syncRedoMarketingConnection);
// this file only loads connections and sets the exit code.
//
// Nightly (redo-marketing-sync.yml): every active redo_connections row, a
// trailing REDO_MARKETING_DAYS_BACK (default 60) days ending yesterday in the
// company's business timezone, overwritten. Redo documents a 5-day
// attribution window, but orders were measured landing on campaigns sent six
// weeks earlier, so recent days keep moving well past 5 days; 60 costs
// barely more than 30 (cost scales with range, not with page count).
//
// Backfill: set REDO_MARKETING_START (and optionally _END); the window is cut
// into <=400-day chunks (Redo's limit), newest first.
//
// Credentials: the SAME redo_connections.api_secret / meta.redo_store_id the
// returns sync uses. A token without the marketing scopes is recorded as
// `skipped` in sync_jobs and does not fail the run -- it is a configuration
// state for that company, not an outage.

import { createClient } from '@supabase/supabase-js';
import { syncRedoMarketingConnection } from './lib/redo-marketing-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const ONLY_COMPANY_ID = process.env.REDO_MARKETING_COMPANY_ID || '';
const DAYS_BACK = process.env.REDO_MARKETING_DAYS_BACK || '60';
const START = process.env.REDO_MARKETING_START || '';
const END = process.env.REDO_MARKETING_END || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  let q = supabase.from('redo_connections').select('id, company_entity_id, api_secret, meta').eq('is_active', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  const { data: connections, error } = await q;
  if (error) throw new Error(`redo_connections load failed: ${error.message}`);
  if (!connections?.length) {
    console.log('[redo-marketing] no active redo_connections');
    return;
  }

  let failed = false;
  for (const connection of connections) {
    try {
      const out = await syncRedoMarketingConnection({
        supabase, connection, daysBack: DAYS_BACK, startDate: START, endDate: END, log: console.log,
      });
      console.log(`[redo-marketing] ${connection.company_entity_id}: ${out.skipped ? `skipped (${out.skipped})` : `${out.window.startDate}..${out.window.endDate} ok`}`);
    } catch (err) {
      failed = true;
      console.error(`[error] ${connection.company_entity_id}: ${err?.message || err}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('[redo-marketing] fatal', err);
  process.exit(1);
});
