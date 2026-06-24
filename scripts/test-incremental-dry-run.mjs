// Dry-run test for runIncrementalSales bounded window.
// Hits the Shopify API with created_at_min + created_at_max, prints order counts.
// No database reads or writes.
//
// Usage:
//   SHOPIFY_DOMAIN=yourstore.myshopify.com \
//   SHOPIFY_TOKEN=shpat_xxx \
//   SHOPIFY_DAYS_BACK=2 \
//   node scripts/test-incremental-dry-run.mjs
//
// Optional: set SHOPIFY_SINCE_ISO to override the min date (simulate a missed run).
//   SHOPIFY_SINCE_ISO=2026-06-20T00:00:00.000Z

import { fetchWithRetry, getAll, DEFAULT_API_VERSION } from './lib/shopify-sync-core.mjs';

const DOMAIN = process.env.SHOPIFY_DOMAIN;
const TOKEN  = process.env.SHOPIFY_TOKEN;
const DAYS_BACK = Number(process.env.SHOPIFY_DAYS_BACK || 2);
const SINCE_ISO_OVERRIDE = process.env.SHOPIFY_SINCE_ISO || null;

if (!DOMAIN || !TOKEN) {
  console.error('SHOPIFY_DOMAIN and SHOPIFY_TOKEN are required');
  process.exit(1);
}

const now = new Date();
const syncedAt = now.toISOString();

let sinceISO;
if (SINCE_ISO_OVERRIDE) {
  sinceISO = SINCE_ISO_OVERRIDE;
  console.log(`[dry-run] Using override since: ${sinceISO}`);
} else {
  const d = new Date(now);
  d.setDate(d.getDate() - DAYS_BACK);
  sinceISO = d.toISOString();
}

const apiVersion = DEFAULT_API_VERSION;
const base = `https://${DOMAIN}/admin/api/${apiVersion}`;
const headers = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json',
};

console.log(`[dry-run] shop:       ${DOMAIN}`);
console.log(`[dry-run] window:     ${sinceISO.slice(0, 10)} → ${syncedAt.slice(0, 10)}`);
console.log(`[dry-run] fetching orders (NO database writes)…\n`);

const url = `${base}/orders.json?status=any`
  + `&created_at_min=${encodeURIComponent(sinceISO)}`
  + `&created_at_max=${encodeURIComponent(syncedAt)}`
  + `&limit=250`;

try {
  const orders = await getAll(headers, url);

  console.log(`[dry-run] orders fetched:  ${orders.length}`);

  if (orders.length) {
    const dates = orders.map(o => o.created_at).sort();
    console.log(`[dry-run] oldest order:    ${dates[0]}`);
    console.log(`[dry-run] newest order:    ${dates[dates.length - 1]}`);

    const byDay = {};
    for (const o of orders) {
      const d = (o.created_at || '').slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    console.log('\n[dry-run] orders by day:');
    for (const [day, count] of Object.entries(byDay).sort()) {
      console.log(`  ${day}  ${count}`);
    }
  }

  console.log('\n[dry-run] ✓ Done — no data written to database');
} catch (err) {
  console.error('[dry-run] ✗ Failed:', err.message);
  process.exit(1);
}
