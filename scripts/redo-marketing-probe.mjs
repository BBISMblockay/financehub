// scripts/redo-marketing-probe.mjs -- one-off diagnostic: probe Redo's API
// for marketing endpoints (Campaigns, Segments, Marketing automations,
// analytics, templates, Consolidations) that show up as scopes in the Redo
// portal's API token editor but have NO matching path in Redo's public
// OpenAPI spec (checked exhaustively against github.com/redoapp/redo-dev,
// release/2.2, redo/api-schema/src/path/ -- 36 documented paths, none
// marketing-related).
//
// Run via the paired "Redo Marketing Probe" GitHub Action (this repo's dev
// sandbox has api.getredo.com blocked by egress policy, same as
// redo-backfill.mjs) or locally with real network access:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/redo-marketing-probe.mjs
//
// Every request is a GET against the api_secret/store id already stored on
// redo_connections -- read-only, matches the token's granted scopes,
// nothing is created or modified on Redo's side. A 404 means the route
// genuinely doesn't exist server-side; a 401/403 means it DOES exist but
// something about auth/scope is rejecting us -- a meaningfully different
// signal worth flagging even when it's not a clean 200.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANY_ENTITY_ID = process.env.REDO_COMPANY_ENTITY_ID || '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'; // Baseballism
const REDO_API_BASE = 'https://api.getredo.com/v2.2';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Candidate paths, following the same `/stores/{storeId}/{resource}` shape
// every DOCUMENTED Redo read endpoint uses (returns, customers, inventory,
// inbound-shipments, invoices, webhooks), plus a couple of plausible
// naming variants per resource since the real path is unknown.
const CANDIDATES = [
  'campaigns',
  'marketing/campaigns',
  'marketing-campaigns',
  'segments',
  'marketing/segments',
  'customer-segments',
  'marketing-automations',
  'automations',
  'marketing/automations',
  'campaigns/analytics',
  'campaign-analytics',
  'marketing-automations/analytics',
  'marketing-automation-analytics',
  'marketing-templates',
  'templates',
  'marketing/templates',
  'consolidations',
];

async function main() {
  const { data: connection, error } = await supabase
    .from('redo_connections')
    .select('api_secret, meta')
    .eq('company_entity_id', COMPANY_ENTITY_ID)
    .single();
  if (error || !connection?.api_secret) {
    throw new Error(`No redo_connections.api_secret for company ${COMPANY_ENTITY_ID}: ${error?.message || 'not found'}`);
  }
  const storeId = connection.meta?.redo_store_id;
  if (!storeId) throw new Error('redo_connections.meta.redo_store_id is not set');

  console.log(`[probe] store=${storeId}\n`);

  for (const path of CANDIDATES) {
    const url = `${REDO_API_BASE}/stores/${storeId}/${path}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.api_secret}` } });
      const text = await res.text();
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
      console.log(`[${res.status}] GET /stores/{storeId}/${path}`);
      if (res.status !== 404) console.log(`        ${snippet}`);
    } catch (err) {
      console.log(`[ERR] GET /stores/{storeId}/${path} -- ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[probe] fatal', err);
  process.exit(1);
});
