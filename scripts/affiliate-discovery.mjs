// scripts/affiliate-discovery.mjs -- Affiliate Studio native prospect
// discovery for every active program with an enabled search source. Logic is
// in scripts/lib/affiliate-discovery-core.mjs; this file loads credentials,
// runs it, and sets the exit code.
//
// Credentials: DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD -- the SILO-owned SERP
// key the SEO module already uses, one for every tenant. Per-program bounds
// (max results per query, max provider cost per run) live on the program and
// source rows, never in env.
//
// AFFILIATE_DISCOVERY_DRY_RUN=1 calls no provider and writes nothing: it lists
// the queries that would run and their caps.
import { createClient } from '@supabase/supabase-js';
import { runDiscovery, fetchSerpLive } from './lib/affiliate-discovery-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
const dryRun = /^(1|true|yes)$/i.test(process.env.AFFILIATE_DISCOVERY_DRY_RUN || '');
const credentials = { login: process.env.DATAFORSEO_LOGIN || '', password: process.env.DATAFORSEO_PASSWORD || '' };
if (!dryRun && (!credentials.login || !credentials.password)) throw new Error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

runDiscovery({
  supabase,
  dryRun,
  onlyProgramId: process.env.AFFILIATE_DISCOVERY_PROGRAM_ID || '',
  fetchSerp: (task) => fetchSerpLive({ credentials, task }),
  log: console.log,
}).then((summary) => {
  console.log(`[affiliate-discovery] ${JSON.stringify(summary)}`);
  if (summary.failed) process.exit(1);
}).catch((err) => {
  console.error('[affiliate-discovery] fatal', err);
  process.exit(1);
});
