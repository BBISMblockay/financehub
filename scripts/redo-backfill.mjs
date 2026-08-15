// scripts/redo-backfill.mjs -- one-time (or ad hoc) historical backfill of
// Redo returns via the REST API, to fill the gap left by the webhook-only
// integration (supabase/functions/redo-webhook), which only captures
// returns created/updated after a store's webhook was wired up. Run this
// manually (`node scripts/redo-backfill.mjs`) or via the paired
// "Redo Returns Backfill" GitHub Action -- this is a point-in-time catch-up
// / reconciliation tool, not a nightly sync, so it is not scheduled.
//
// Requires network egress to api.getredo.com -- this repo's own dev sandbox
// blocks that domain outright, so scripts/lib/redo-sync-core.mjs was written
// against Redo's real OpenAPI spec (verified via github.com/redoapp/redo-dev)
// but has NOT been live-tested end to end. Run it somewhere with real
// network access and watch the first page's log line closely.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  -- required
//   REDO_COMPANY_ENTITY_ID   -- defaults to Baseballism
//   REDO_UPDATED_AT_MIN      -- ISO date; blank = full history
//   REDO_UPDATED_AT_MAX      -- ISO date; blank = now
//   REDO_STATUS              -- optional status filter (open/complete/rejected)
//   REDO_VALIDATE_CSV        -- optional local path to a Redo "export returns"
//     CSV (columns include a "Redo ID" column) to cross-check API coverage
//     against. Never commit one of these -- it carries customer PII (name,
//     address) -- this only ever reads a local path at run time.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import Papa from 'papaparse';
import { backfillRedoReturns } from './lib/redo-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANY_ENTITY_ID = process.env.REDO_COMPANY_ENTITY_ID || '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'; // Baseballism
const UPDATED_AT_MIN = process.env.REDO_UPDATED_AT_MIN || '';
const UPDATED_AT_MAX = process.env.REDO_UPDATED_AT_MAX || '';
const STATUS = process.env.REDO_STATUS || '';
const VALIDATE_CSV = process.env.REDO_VALIDATE_CSV || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function validateAgainstCsv(csvPath, returnIds) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const csvIds = parsed.data.map((row) => row['Redo ID']).filter(Boolean);
  const missing = csvIds.filter((id) => !returnIds.has(id));

  console.log(
    `[redo-backfill] CSV validation: ${csvIds.length} rows in CSV, ` +
    `${csvIds.length - missing.length} matched, ${missing.length} missing from the API pull`
  );
  if (missing.length) {
    console.log('[redo-backfill] missing sample (up to 20):', missing.slice(0, 20));
  }
  return { csvRows: csvIds.length, matched: csvIds.length - missing.length, missingCount: missing.length };
}

async function main() {
  const { data: connection, error } = await supabase
    .from('redo_connections')
    .select('id, api_secret, meta')
    .eq('company_entity_id', COMPANY_ENTITY_ID)
    .single();
  if (error || !connection) {
    throw new Error(`No redo_connections row for company ${COMPANY_ENTITY_ID}: ${error?.message || 'not found'}`);
  }
  if (!connection.api_secret) {
    throw new Error('redo_connections.api_secret is not set -- add it via /v2/integrations.html first');
  }

  const storeId = connection.meta?.redo_store_id;
  if (!storeId) {
    throw new Error(
      'redo_connections.meta.redo_store_id is not set. Find it in the Redo dashboard URL ' +
      '(app.getredo.com/stores/{storeId}/settings/developer) and set it, e.g.:\n' +
      `  update redo_connections set meta = meta || '{"redo_store_id":"..."}' where company_entity_id = '${COMPANY_ENTITY_ID}';`
    );
  }

  console.log(
    `[redo-backfill] company=${COMPANY_ENTITY_ID} store=${storeId} ` +
    `since=${UPDATED_AT_MIN || '(full history)'} until=${UPDATED_AT_MAX || '(now)'}` +
    `${STATUS ? ` status=${STATUS}` : ''}`
  );

  const { returnIds, ...summary } = await backfillRedoReturns({
    supabase,
    companyEntityId: COMPANY_ENTITY_ID,
    apiSecret: connection.api_secret,
    storeId,
    updatedAtMin: UPDATED_AT_MIN || undefined,
    updatedAtMax: UPDATED_AT_MAX || undefined,
    status: STATUS || undefined,
  });

  console.log(
    `[redo-backfill] done: ${summary.pages} pages, ${summary.returnsSeen} returns seen, ` +
    `${summary.returnsUpserted} upserted, ${summary.itemsUpserted} items`
  );

  let validation = null;
  if (VALIDATE_CSV) validation = validateAgainstCsv(VALIDATE_CSV, returnIds);

  await supabase
    .from('redo_connections')
    .update({
      meta: { ...(connection.meta || {}), last_backfill_at: new Date().toISOString(), last_backfill_result: summary },
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id);

  console.log('[redo-backfill] summary', JSON.stringify({ ...summary, validation }, null, 2));
}

main().catch((err) => {
  console.error('[redo-backfill] fatal', err);
  process.exit(1);
});
