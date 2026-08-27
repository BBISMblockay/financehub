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
 * Scope: only companies that actually have an enabled connection for the feed
 * being checked -- a company with no sync pipeline is not "stale", it just has
 * no data, and alarming on it would train everyone to ignore this.
 *
 * Covers BOTH nightly feeds, because on 2026-08-27 GitHub dropped both of them
 * on the same morning: shopify-sync (sales_by_day) and ad-platforms-sync
 * (marketing_kpis_daily). Checking only sales would have caught half of it and
 * left the Meta numbers quietly ~4.5 hours short on the most recent day.
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

// Each feed names the table it lands in and the connection table that decides
// whether a company is even expected to have it.
const FEEDS = [
  {
    label: 'sales',
    table: 'sales_by_day',
    connTable: 'shopify_connections',
    workflow: 'shopify-sync.yml',
  },
  {
    label: 'marketing',
    table: 'marketing_kpis_daily',
    connTable: 'ad_platform_connections',
    workflow: 'ad-platforms-sync.yml',
  },
];

async function companiesFor(connTable) {
  let q = db.from(connTable).select('company_entity_id').eq('is_active', true);
  // shopify_connections gates on sync_enabled + a token; ad_platform_connections
  // is keyed differently, so only apply what each table actually has.
  if (connTable === 'shopify_connections') {
    q = q.eq('sync_enabled', true).not('access_token', 'is', null);
  }
  const { data, error } = await q;
  if (error) throw new Error(`${connTable} load failed: ${error.message}`);
  return [...new Set((data || []).map((c) => c.company_entity_id).filter(Boolean))];
}

async function main() {
  const today = pacificToday();
  const stale = [];
  let checked = 0;

  for (const feed of FEEDS) {
    const companyIds = await companiesFor(feed.connTable);
    if (!companyIds.length) {
      console.log(`[freshness] ${feed.label}: no companies with an enabled connection — skipping`);
      continue;
    }

    for (const companyId of companyIds) {
      // Newest day_date for this company. One indexed descending read, no scan.
      const { data, error } = await db
        .from(feed.table)
        .select('day_date')
        .eq('company_entity_id', companyId)
        .order('day_date', { ascending: false })
        .limit(1);
      if (error) throw new Error(`${feed.table} probe failed for ${companyId}: ${error.message}`);

      const maxDay = data?.[0]?.day_date || null;
      const lag = maxDay ? daysBetween(today, maxDay) : null;
      const ok = lag !== null && lag <= MAX_LAG_DAYS;
      checked++;

      console.log(
        `[freshness] ${feed.label.padEnd(9)} ${companyId}  latest=${maxDay || 'NONE'}  lag=${lag === null ? 'n/a' : `${lag}d`}  ${ok ? 'ok' : 'STALE'}`,
      );
      if (!ok) stale.push({ feed, companyId, maxDay, lag });
    }
  }

  if (stale.length) {
    console.error('');
    console.error(`[freshness] STALE — Pacific today is ${today}, max allowed lag is ${MAX_LAG_DAYS}d`);
    for (const s of stale) {
      console.error(`  [${s.feed.label}] ${s.companyId}: latest ${s.maxDay || 'NONE'} (${s.lag === null ? 'no rows' : `${s.lag}d behind`})`);
    }
    console.error('');
    console.error('The nightly sync behind that feed has probably not run. Check:');
    for (const wf of [...new Set(stale.map((s) => s.feed.workflow))]) {
      console.error(`  https://github.com/BBISMblockay/financehub/actions/workflows/${wf}`);
    }
    console.error('If the scheduled run is simply ABSENT from that list rather than red,');
    console.error('GitHub dropped it — dispatch the workflow by hand with the default inputs.');
    process.exit(1);
  }

  console.log(`[freshness] all ${checked} feed/company pair(s) within ${MAX_LAG_DAYS}d of Pacific ${today}`);
}

main().catch((err) => {
  console.error(`[freshness] check failed: ${err.message || err}`);
  process.exit(1);
});
