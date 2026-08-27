#!/usr/bin/env node
/**
 * Sales freshness alarm.
 *
 * WHY THIS EXISTS, and why it is a SEPARATE workflow rather than a step at the
 * end of shopify-sync.yml: on 2026-08-27 GitHub silently DROPPED the 08:30 UTC
 * nightly. Not failed -- dropped. Scheduled triggers are best-effort, and a
 * dropped run leaves no row in the Actions list, no red X, and no notification.
 * sales_by_day sat two days stale and the first person to notice was a marketer
 * who could not pick a date in a report, hours before a meeting.
 *
 * A check that lives inside the sync cannot catch that failure, because the
 * failure IS "the sync did not run". The alarm has to be independently
 * scheduled. This one is, and it deliberately does no work beyond one query:
 * anything heavier is another thing that can break.
 *
 * It reports by FAILING. A failed GitHub Actions run emails the repo owner with
 * no extra credentials, no Resend key, no webhook to rot. The exit code is the
 * notification.
 *
 * Scope: only companies that actually have an enabled Shopify connection --
 * a company with no sync pipeline is not "stale", it just has no data, and
 * alarming on it would train everyone to ignore this.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Sales are only ever complete through the last finished Pacific day, so a lag
// of 1 is healthy, not stale. 2 means we missed a nightly.
const MAX_LAG_DAYS = Number(process.env.MAX_LAG_DAYS || 1);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// The business day boundary is Pacific, not UTC. Using UTC here would raise a
// false alarm every day between Pacific midnight and 00:00 UTC.
function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(`${isoA}T00:00:00Z`);
  const b = Date.parse(`${isoB}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

async function main() {
  const { data: conns, error: connErr } = await db
    .from('shopify_connections')
    .select('company_entity_id, shop_domain')
    .eq('is_active', true)
    .eq('sync_enabled', true)
    .not('access_token', 'is', null);
  if (connErr) throw new Error(`shopify_connections load failed: ${connErr.message}`);

  const companyIds = [...new Set((conns || []).map((c) => c.company_entity_id).filter(Boolean))];
  if (!companyIds.length) {
    console.log('[freshness] no companies with an enabled Shopify connection — nothing to check');
    return;
  }

  const today = pacificToday();
  const stale = [];

  for (const companyId of companyIds) {
    // Newest day_date for this company. One indexed descending read, no scan.
    const { data, error } = await db
      .from('sales_by_day')
      .select('day_date')
      .eq('company_entity_id', companyId)
      .order('day_date', { ascending: false })
      .limit(1);
    if (error) throw new Error(`sales_by_day probe failed for ${companyId}: ${error.message}`);

    const maxDay = data?.[0]?.day_date || null;
    const lag = maxDay ? daysBetween(today, maxDay) : null;
    const ok = lag !== null && lag <= MAX_LAG_DAYS;

    console.log(
      `[freshness] ${companyId}  latest=${maxDay || 'NONE'}  lag=${lag === null ? 'n/a' : `${lag}d`}  ${ok ? 'ok' : 'STALE'}`,
    );
    if (!ok) stale.push({ companyId, maxDay, lag });
  }

  if (stale.length) {
    console.error('');
    console.error(`[freshness] STALE — Pacific today is ${today}, max allowed lag is ${MAX_LAG_DAYS}d`);
    for (const s of stale) {
      console.error(`  ${s.companyId}: latest sales day ${s.maxDay || 'NONE'} (${s.lag === null ? 'no rows' : `${s.lag}d behind`})`);
    }
    console.error('');
    console.error('The nightly Shopify sync has probably not run. Check:');
    console.error('  https://github.com/BBISMblockay/financehub/actions/workflows/shopify-sync.yml');
    console.error('If the scheduled run is simply absent from that list, GitHub dropped it —');
    console.error('dispatch the workflow by hand with the default inputs.');
    process.exit(1);
  }

  console.log(`[freshness] all ${companyIds.length} company(ies) within ${MAX_LAG_DAYS}d of Pacific ${today}`);
}

main().catch((err) => {
  console.error(`[freshness] check failed: ${err.message || err}`);
  process.exit(1);
});
