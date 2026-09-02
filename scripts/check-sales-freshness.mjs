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
import { appendFileSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Sales are only ever complete through the last finished Pacific day, so a lag
// of 1 is healthy, not stale. 2 means we missed a nightly.
const MAX_LAG_DAYS = Number(process.env.MAX_LAG_DAYS || 1);
// The workflow runs this twice: once to DECIDE whether to self-heal (where a
// stale result must not fail the job before the heal gets a chance to run),
// and once afterwards to VERIFY (where stale is a genuine failure).
const FAIL_ON_STALE = process.env.FAIL_ON_STALE !== 'false';

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

// A day being PRESENT is not the same as a day being COMPLETE, and the gap
// between those two is what let 2026-08-30 pass this check twice while missing
// six hours of sales and ~$19k of Meta spend. day_date 08-30 existed, lag was
// 1, everything read healthy -- but every row had been captured at 12:23pm
// Pacific ON the 30th, mid-day, and no later run corrected it.
//
// A day is only complete once it has been captured AFTER that Pacific day
// ended. Comparing the newest synced_at for the day against Pacific midnight
// that follows it is the whole test.
function pacificOffsetMs(instant) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset',
  }).formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value || 'GMT-8';
  const m = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return -8 * 3600000;
  const hours = Number(m[1]);
  const mins = Number(m[2] || 0) * Math.sign(hours || 1);
  return (hours * 60 + mins) * 60000;
}

/** Midnight at the START of isoDay, Pacific, as a UTC instant. The offset is
 * read at ~noon that day so a 2am DST transition cannot pick the wrong side. */
function pacificMidnightUtc(isoDay) {
  const noonish = new Date(`${isoDay}T20:00:00Z`);
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) - pacificOffsetMs(noonish));
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
      const lagOk = lag !== null && lag <= MAX_LAG_DAYS;
      checked++;

      // Completeness of the last COMPLETE Pacific day -- yesterday. This is the
      // day someone checking in at 8am expects to be finished.
      const required = addDaysIso(today, -1);
      let partial = false;
      let capturedAt = null;
      if (lagOk) {
        const { data: cap, error: capErr } = await db
          .from(feed.table)
          .select('synced_at')
          .eq('company_entity_id', companyId)
          .eq('day_date', required)
          .order('synced_at', { ascending: false })
          .limit(1);
        if (capErr) throw new Error(`${feed.table} capture probe failed for ${companyId}: ${capErr.message}`);
        capturedAt = cap?.[0]?.synced_at || null;
        // No capture timestamp at all (older rows predate synced_at) is not
        // evidence of a partial day -- do not manufacture an alarm from it.
        if (capturedAt) {
          partial = new Date(capturedAt) < pacificMidnightUtc(today);
        }
      }

      const ok = lagOk && !partial;
      const verdict = !lagOk ? 'STALE' : partial ? 'PARTIAL' : 'ok';
      console.log(
        `[freshness] ${feed.label.padEnd(9)} ${companyId}  latest=${maxDay || 'NONE'}  lag=${lag === null ? 'n/a' : `${lag}d`}`
        + `  ${required} captured=${capturedAt || 'n/a'}  ${verdict}`,
      );
      if (!ok) stale.push({ feed, companyId, maxDay, lag, partial, required, capturedAt });
    }
  }

  // Tell the workflow which feeds to re-sync. Written even on success so the
  // conditional steps always have a defined value to test.
  emitOutputs(stale);

  if (stale.length) {
    console.error('');
    console.error(`[freshness] STALE — Pacific today is ${today}, max allowed lag is ${MAX_LAG_DAYS}d`);
    for (const s of stale) {
      console.error(s.partial
        ? `  [${s.feed.label}] ${s.companyId}: ${s.required} is PARTIAL — captured ${s.capturedAt}, before that Pacific day ended`
        : `  [${s.feed.label}] ${s.companyId}: latest ${s.maxDay || 'NONE'} (${s.lag === null ? 'no rows' : `${s.lag}d behind`})`);
    }
    console.error('');
    console.error('The nightly sync behind that feed has probably not run. Check:');
    for (const wf of [...new Set(stale.map((s) => s.feed.workflow))]) {
      console.error(`  https://github.com/BBISMblockay/financehub/actions/workflows/${wf}`);
    }
    console.error('If the scheduled run is simply ABSENT from that list rather than red,');
    console.error('GitHub dropped it — dispatch the workflow by hand with the default inputs.');
    if (FAIL_ON_STALE) process.exit(1);
    console.error('(FAIL_ON_STALE=false — reporting only, the workflow will try to self-heal.)');
    return;
  }

  console.log(`[freshness] all ${checked} feed/company pair(s) within ${MAX_LAG_DAYS}d of Pacific ${today}`);
}

function emitOutputs(stale) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const labels = new Set(stale.map((s) => s.feed.label));
  const lines = FEEDS.map((f) => `${f.label}_stale=${labels.has(f.label) ? 'true' : 'false'}`);
  lines.push(`any_stale=${stale.length ? 'true' : 'false'}`);
  appendFileSync(out, `${lines.join('\n')}\n`);
}

main().catch((err) => {
  console.error(`[freshness] check failed: ${err.message || err}`);
  process.exit(1);
});
