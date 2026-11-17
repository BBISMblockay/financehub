// scripts/affiliate-commissions.mjs -- Affiliate Studio nightly commissions
// and the "your code is live" sweep. Logic: scripts/lib/affiliate-commissions-core.mjs.
import { createClient } from '@supabase/supabase-js';
import { runCommissions } from './lib/affiliate-commissions-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function makeShopifyCodes() {
  // SILO makes the codes still waiting for Shopify (affiliate-invite); a store
  // that has not granted write_discounts just leaves them waiting. Never fails the run.
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/affiliate-invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_shopify_codes' }),
    });
    const body = await res.json().catch(() => ({}));
    const tally = {};
    for (const r of body.results || []) tally[r.status] = (tally[r.status] || 0) + 1;
    console.log(`[affiliate-commissions] shopify codes ${res.status} ${JSON.stringify(tally)}`);
  } catch (err) { console.log(`[affiliate-commissions] shopify codes skipped: ${err?.message}`); }
}

async function deliverNotices() {
  await makeShopifyCodes();
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/affiliate-invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'deliver_code_notices' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`deliver_code_notices ${res.status}: ${body?.error || ''}`);
  return { sent: (body.delivered || []).length };
}

runCommissions({ supabase, deliverNotices, log: console.log, onlyProgramId: process.env.AFFILIATE_PROGRAM_ID || '' })
  .then((s) => { console.log(`[affiliate-commissions] ${JSON.stringify(s)}`); if (s.failed) process.exit(1); })
  .catch((err) => { console.error('[affiliate-commissions] fatal', err); process.exit(1); });
