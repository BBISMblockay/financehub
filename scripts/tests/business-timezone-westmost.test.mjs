// The sync scripts' Pacific day boundary is only safe while Pacific is the
// WESTERNMOST timezone SILO supports. This test pins that assumption to the
// list onboarding actually accepts.
//
// Why it matters (20260924130000's header has the whole sweep): the database
// now anchors every day boundary on the company's own timezone, but five
// script sites still reason in Pacific on purpose -- the Shopify sync's forced
// yesterday/today rebuild, the ad-platform window's end date, the Search
// Console window (Google's own days ARE Pacific), the sales freshness alarm,
// and v2/daily-trend-kpis.js's "still in progress" label. Each uses Pacific as
// a BOUND: if no supported company is ever on an earlier calendar date than
// Pacific, then
//   * a Pacific "yesterday"/"today" pair always contains the company's own
//     yesterday, so the forced rebuild still completes it;
//   * a window ending on Pacific today never writes a day the company (or an
//     ad account in its zone) has not finished;
//   * a day called partial on the Pacific clock is never a finished one called
//     complete -- the error is only ever in the conservative direction.
// Adding Alaska or Hawaii breaks all three, and that is a scheduling change
// (the 08:30 UTC cron is still the previous evening there), not an INSERT.
//
// Run: node scripts/tests/business-timezone-westmost.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const migrations = [
  'supabase/migrations/20260918120000_company_onboarding.sql',
  'supabase/migrations/20260924130400_business_timezone_onboarding.sql',
];

// Every tz_name inserted into supported_business_timezones by any migration.
const zones = new Set();
for (const path of migrations) {
  const sql = await readFile(new URL(path, root), 'utf8');
  for (const block of sql.matchAll(/insert into public\.supported_business_timezones[\s\S]*?;/g)) {
    for (const m of block[0].matchAll(/\(\s*'([A-Za-z_]+\/[A-Za-z_]+)'/g)) zones.add(m[1]);
  }
}
assert.ok(zones.has('America/Los_Angeles'), 'Pacific must be found');
assert.ok(zones.size >= 5, `the sweep's zones must be found, got ${[...zones].join(', ')}`);

const dateIn = (tz, instant) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(instant);

// Every 30 minutes across a full year, so both DST transitions (and Arizona's
// lack of one) are crossed.
let checked = 0;
const start = Date.UTC(2026, 0, 1);
for (let t = start; t < start + 366 * 86400000; t += 30 * 60000) {
  const instant = new Date(t);
  const pacific = dateIn('America/Los_Angeles', instant);
  for (const tz of zones) {
    const local = dateIn(tz, instant);
    assert.ok(local >= pacific,
      `${tz} is on ${local} while Pacific is on ${pacific} at ${instant.toISOString()}: a zone west of `
      + 'Pacific breaks the scripts\' Pacific bound. Add it only with its own sync schedule and per-company '
      + 'boundaries in the scripts.');
    // ...and never more than a day ahead, or "Pacific yesterday + today" could
    // miss the company's yesterday entirely.
    const ahead = (Date.parse(local) - Date.parse(pacific)) / 86400000;
    assert.ok(ahead <= 1, `${tz} is ${ahead} days ahead of Pacific at ${instant.toISOString()}`);
    checked += 1;
  }
}
console.log(`ok - ${zones.size} supported timezones are never west of Pacific (${checked} instants checked)`);
