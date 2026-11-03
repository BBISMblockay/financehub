// windsor-sync (scripts/lib/windsor-sync-core.mjs): Windsor -> SILO tables.
// One owner key reads every client, so what this suite pins is that a row is
// written only for the account it was asked about, under the company of that
// account's mapping row; that history resumes where it stopped; and that a
// refused field, an error or a spent budget is recorded, not hidden.
//
// Mutations (CI runs each and requires a failure):
//   WINDSOR_SYNC_MUTATION=accountfilter   rows are kept without checking their account_id
//   WINDSOR_SYNC_MUTATION=payloadcompany  the company comes from Windsor's row
//   WINDSOR_SYNC_MUTATION=selectaccounts  the request is not limited to the one account
//   WINDSOR_SYNC_MUTATION=resume          history progress is never saved
//   WINDSOR_SYNC_MUTATION=window          rows outside the requested window are written
//   WINDSOR_SYNC_MUTATION=refusedcolumn   a refused column field still writes (overwriting with 0)
//   WINDSOR_SYNC_MUTATION=syncoptions     the sync omits TikTok's include_inactive option
//   WINDSOR_SYNC_MUTATION=directsync      Meta/Google through Windsor go into marketing_kpis_daily (double count)
//   WINDSOR_SYNC_MUTATION=huntmerge       hunted values are matched without the account (another client's leak in)
//   WINDSOR_SYNC_MUTATION=override        a company's field mapping is ignored
//   WINDSOR_SYNC_MUTATION=skiprefused     a refused hunted field is asked again in every window
//   WINDSOR_SYNC_MUTATION=nullnotzero     a measure the connector lacks is stored as 0
//
// Run: node --test scripts/tests/windsor-sync.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import { hashRow } from '../lib/shopify-sync-core.mjs';

const MUT = process.env.WINDSOR_SYNC_MUTATION || '';
const libUrl = new URL('../lib/windsor-sync-core.mjs', import.meta.url);

async function loadCore() {
  let src = fs.readFileSync(libUrl, 'utf8');
  const sub = (from, to) => { assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`); src = src.split(from).join(to); };
  if (MUT === 'accountfilter') sub('const { kept, foreign, unattributed } = filterRowsToAccount(rows, accountId);', 'const kept = rows; const foreign = 0; const unattributed = 0;');
  if (MUT === 'payloadcompany') sub('const row = dataset.toRow({ ...r, date: day }, ctx);', 'const row = dataset.toRow({ ...r, date: day }, { ...ctx, companyId: r.company_entity_id ?? ctx.companyId });');
  if (MUT === 'selectaccounts') sub('date_from: from, date_to: to, select_accounts: accountId,', 'date_from: from, date_to: to,');
  if (MUT === 'resume') sub("if (w.kind === 'history') historyFrom = w.from;", '');
  if (MUT === 'window') sub("if (!DATE_RE.test(day) || day < from || day > to) { outOfWindow += 1; continue; }", "if (!DATE_RE.test(day)) { outOfWindow += 1; continue; }");
  if (MUT === 'refusedcolumn') sub('if (blocking.length) {', 'if (false) {');
  if (MUT === 'syncoptions') sub('options: previewOptions(connector),', '');
  if (MUT === 'directsync') sub("if (choice.kind === 'ad') {", "if (choice.kind !== 'fixed') {");
  if (MUT === 'huntmerge') sub("const mergeId = (dataset, r) => `${r?.account_id ?? ''}\u0000", "const mergeId = (dataset, r) => `\u0000");
  if (MUT === 'override') sub('const auto = autoDataset(account.ds_id, catalog, overrides);', 'const auto = autoDataset(account.ds_id, catalog);');
  if (MUT === 'skiprefused') sub('refusedThisRun.add(f);', '');
  if (MUT === 'nullnotzero') sub("out[col] = chosen[col] ? numOrNull(r[chosen[col]]) : null;", "out[col] = chosen[col] ? (numOrNull(r[chosen[col]]) ?? 0) : 0;");
  // Absolute imports so the temp copy resolves the repo's modules.
  src = src.replace("'../../supabase/functions/windsor-broker/windsor-lib.mjs'", `'${new URL('../../supabase/functions/windsor-broker/windsor-lib.mjs', libUrl).href}'`)
    .replace("'./shopify-sync-core.mjs'", `'${new URL('./shopify-sync-core.mjs', libUrl).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsor-sync-'));
  const file = path.join(dir, 'windsor-sync-core.mjs');
  fs.writeFileSync(file, src);
  return import(file);
}
const core = await loadCore();
const { syncAccount, planWindows, fieldsNamedIn, DATASETS } = core;

const KEY = 'owner-key-SECRET-77aa';
const A = 'company-A';
const B = 'company-B';
const NOW = new Date('2026-11-03T18:00:00Z'); // Pacific 2026-11-03, so the newest day is 11-02

function world(accounts) {
  const fake = createFakeSupabase();
  fake.tables.set('windsor_linked_accounts', accounts.map((a) => ({ ...a })));
  return fake;
}

// A fake Windsor connectors API. `rowsFor(connector, url)` returns the rows.
// `catalogs` maps a connector to Windsor's public field list for it; a
// connector without one answers 404 there, so nothing is hunted.
function fakeWindsor(rowsFor, catalogs = {}) {
  const log = [];
  const catalogLog = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const fieldsPath = /^\/([a-z0-9_]+)\/fields$/.exec(u.pathname);
    if (fieldsPath) {
      catalogLog.push(u);
      assert.equal(u.searchParams.get('api_key'), null, 'the public field list is read without the owner key');
      const cat = catalogs[fieldsPath[1]];
      return cat ? { ok: true, status: 200, text: async () => JSON.stringify(cat) } : { ok: false, status: 404, text: async () => 'not found' };
    }
    log.push(u);
    const connector = u.pathname.slice(1);
    const out = rowsFor(connector, u);
    if (out && out.status) return { ok: false, status: out.status, text: async () => out.text };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: out ?? [] }) };
  };
  return { fetchImpl, log, catalogLog };
}

const tiktokAcct = { id: 'm-t', company_entity_id: A, ds_id: 'tiktok', account_id: '7000000000000000001', account_name: 'A TikTok' };
const klaviyoAcct = { id: 'm-k', company_entity_id: A, ds_id: 'klaviyo', account_id: 'KA1', account_name: 'A Klaviyo' };

const run = (fake, fw, account, opts = {}) => syncAccount({
  supabase: fake, fetchImpl: fw.fetchImpl, key: KEY, account, now: NOW, historyMonths: 0, maxHistoryWindows: 0, ...opts,
});

test('TikTok lands in marketing_kpis_daily under the mapping row\'s company, this account only', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor((c, u) => {
    assert.equal(c, 'tiktok');
    return [
      { date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', campaign: 'Spring', impressions: '1,000', clicks: 12, spend: 5.5, complete_payment: 2, total_complete_payment_rate: 80, reach: 900, company_entity_id: B },
      { date: '2026-11-01', account_id: '7999999999999999999', campaign_id: 'cX', campaign: 'Other client', spend: 99 },
      { date: '2026-11-01', campaign_id: 'cY', spend: 1 },
    ];
  });
  const r = await run(fake, fw, tiktokAcct);
  assert.equal(r.status, 'success');
  const rows = fake.rows('marketing_kpis_daily');
  assert.equal(rows.length, 1, 'another account\'s row and an unattributed row are never written');
  const row = rows[0];
  assert.equal(row.company_entity_id, A);
  assert.equal(row.platform, 'tiktok_ads');
  assert.equal(row.source, 'windsor');
  assert.equal(row.impressions, 1000);
  assert.equal(row.conversion_value, 80);
  assert.equal(row.extra.reach, 900);
  assert.equal(row.leads, null, 'not reported stays null');
  assert.equal(row.row_hash, hashRow([A, 'tiktok_ads', 'tiktok_ads', '7000000000000000001', 'c1', '2026-11-01']),
    'same identity as the direct TikTok sync, so a later swap updates in place');
  const u = fw.log[0];
  assert.equal(u.searchParams.get('select_accounts'), '7000000000000000001');
  assert.equal(u.searchParams.get('date_to'), '2026-11-02');
  assert.equal(u.searchParams.get('date_from'), '2026-09-29');
  assert.match(u.searchParams.get('fields'), /(^|,)account_id(,|$)/);
  const m = fake.rows('windsor_linked_accounts')[0];
  assert.equal(m.last_sync_status, 'success');
  assert.equal(m.synced_through, '2026-11-02');
});

test('Klaviyo writes the account, campaign and flow reports', async () => {
  const fake = world([klaviyoAcct]);
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields');
    if (f.includes('flow_id')) return [{ date: '2026-11-01', account_id: 'KA1', flow_id: 'F1', flow_name: 'Welcome', flow_message_id: 'M1', flow_message_name: 'Email 1', flow_recipients: 40, flow_conversion_value: '120.50', flow_status: 'live', flow_click_rate: 0.1 }];
    if (f.includes('campaign_id')) return [{ date: '2026-11-01', account_id: 'KA1', campaign_id: 'C1', campaign: 'Drop', campaign_channel: 'email', subject: 'New hats', campaign_report_opens_unique: 300 }];
    return [{ date: '2026-11-01', account_id: 'KA1', account_name: 'A Klaviyo', sent_emails: 500, opens: 320, revenue: 900, sent_sms: 10 }];
  });
  const r = await run(fake, fw, klaviyoAcct);
  assert.equal(r.status, 'success');
  const rows = fake.rows('klaviyo_performance_daily');
  const by = Object.fromEntries(rows.map((x) => [x.report, x]));
  assert.deepEqual(Object.keys(by).sort(), ['account', 'campaign', 'flow']);
  assert.ok(rows.every((x) => x.company_entity_id === A));
  assert.equal(by.account.object_id, '');
  assert.equal(by.account.recipients, 500);
  assert.equal(by.account.metrics.sent_sms, 10);
  assert.equal(by.campaign.object_id, 'C1');
  assert.equal(by.campaign.opens_unique, 300);
  assert.equal(by.campaign.attributes.subject, 'New hats');
  assert.equal(by.flow.object_id, 'M1');
  assert.equal(by.flow.parent_name, 'Welcome');
  assert.equal(by.flow.revenue, 120.5);
  assert.equal(by.flow.metrics.flow_click_rate, 0.1);
  assert.equal(by.flow.attributes.flow_status, 'live');
});

test('rows dated outside the requested window are not written', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor(() => [
    { date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 1 },
    { date: '2026-11-03', account_id: '7000000000000000001', campaign_id: 'c1', spend: 1 },
    { date: '2025-01-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 1 },
  ]);
  const r = await run(fake, fw, tiktokAcct);
  assert.deepEqual(fake.rows('marketing_kpis_daily').map((x) => x.day_date), ['2026-11-01']);
  assert.equal(r.windows[0].datasets.campaign.out_of_window, 2);
});

test('history walks back month by month, saves progress, and resumes there', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor(() => []);
  const r1 = await run(fake, fw, tiktokAcct, { historyMonths: 6, maxHistoryWindows: 2 });
  assert.equal(r1.windows.length, 3);
  const saved = fake.rows('windsor_linked_accounts')[0].history_from;
  assert.equal(saved, r1.windows[2].from);
  assert.equal(r1.history_complete, false);
  const r2 = await run(fake, fw, { ...tiktokAcct, history_from: saved }, { historyMonths: 6, maxHistoryWindows: 2 });
  assert.equal(r2.windows[1].to, shift(saved, -1), 'the next run starts the day before where the last one stopped');
  const r3 = await run(fake, fw, { ...tiktokAcct, history_from: fake.rows('windsor_linked_accounts')[0].history_from }, { historyMonths: 6, maxHistoryWindows: 10 });
  assert.equal(r3.history_complete, true);
  assert.equal(fake.rows('windsor_linked_accounts')[0].history_from, '2026-05-02');
});
function shift(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

test('planWindows never overlaps and stops at the target', () => {
  const { windows, target } = planWindows({ today: '2026-11-03', historyFrom: null, historyMonths: 3, maxHistoryWindows: 99 });
  for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i].to, shift(windows[i - 1].from, -1));
  assert.equal(windows.at(-1).from, target);
});

test('a field Windsor refuses is dropped, the rest still lands, and the run says so', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor((c, u) => {
    if (u.searchParams.get('fields').split(',').includes('onsite_shopping')) return { status: 400, text: '{"error":"Unknown field: onsite_shopping"}' };
    return [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 3 }];
  });
  const r = await run(fake, fw, tiktokAcct);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.dropped_fields, ['campaign.onsite_shopping']);
  assert.equal(fake.rows('marketing_kpis_daily').length, 1);
  assert.match(fake.rows('windsor_linked_accounts')[0].last_sync_error, /onsite_shopping/);
});

test('an error is recorded on the mapping row with the key redacted, and does not throw', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor((c, u) => ({ status: 500, text: `boom ${u.toString()}` }));
  const r = await run(fake, fw, tiktokAcct);
  assert.equal(r.status, 'error');
  const m = fake.rows('windsor_linked_accounts')[0];
  assert.equal(m.last_sync_status, 'error');
  assert.ok(!m.last_sync_error.includes(KEY), 'the owner key never lands in the database');
});

test('a connector whose field list cannot be read makes no data call and is recorded as an error', async () => {
  const fake = world([{ ...tiktokAcct, id: 'm-x', ds_id: 'mysql' }]);
  const fw = fakeWindsor(() => []);
  const r = await run(fake, fw, { ...tiktokAcct, id: 'm-x', ds_id: 'mysql' });
  assert.equal(r.status, 'error');
  assert.equal(fw.log.length, 0);
  assert.match(fake.rows('windsor_linked_accounts')[0].last_sync_error, /field list/);
});

test('a connector whose field list has no date or account cannot place a row: unsupported', async () => {
  const acct = { ...tiktokAcct, id: 'm-x', ds_id: 'mysql' };
  const fake = world([acct]);
  const fw = fakeWindsor(() => [], { mysql: [{ id: 'rows', type: 'NUMERIC' }] });
  const r = await run(fake, fw, acct);
  assert.equal(r.status, 'unsupported');
  assert.equal(fw.log.length, 0);
});

// ── Any connector, mapped from Windsor's field list ─────────────────────────
const PIN = '549000000001';
const pinAcct = { id: 'm-p', company_entity_id: A, ds_id: 'pinterest', account_id: PIN, account_name: 'A Pins' };
const pinCatalog = [
  { id: 'date', type: 'DATE', table: null }, { id: 'account_id', type: 'TEXT' }, { id: 'account_name', type: 'TEXT' },
  { id: 'campaign_id', type: 'TEXT', table: 'Campaign' }, { id: 'campaign', type: 'TEXT', table: 'Campaign' },
  { id: 'spend', type: 'NUMERIC', table: 'Performance' }, { id: 'impressions', type: 'NUMERIC', table: 'Performance' },
  { id: 'clicks', type: 'NUMERIC', table: 'Performance' }, { id: 'total_conversions', type: 'NUMERIC', table: 'Conversions' },
  { id: 'saves', type: 'NUMERIC', table: 'Engagement' }, { id: 'ctr', type: 'PERCENT', table: 'Performance' },
  { id: 'video_p100', type: 'NUMERIC', table: 'Video' },
];

test('an ad-like connector with no hand-made mapping lands in marketing_kpis_daily with every numeric field', async () => {
  const fake = world([pinAcct]);
  const fw = fakeWindsor((c, u) => {
    assert.equal(c, 'pinterest');
    assert.equal(u.searchParams.get('select_accounts'), PIN);
    const f = u.searchParams.get('fields').split(',');
    const base = { date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', campaign: 'Fall' };
    if (f.includes('spend')) {
      return [{ ...base, account_name: 'A Pins', spend: 12, impressions: 3000, clicks: 40, total_conversions: 3, company_entity_id: B },
        { date: '2026-11-01', account_id: '549999999999', campaign_id: 'other', spend: 500, impressions: 1, clicks: 1 }];
    }
    // Hunted batch: the identity fields come along so it can be matched.
    assert.ok(f.includes('date') && f.includes('account_id') && f.includes('campaign_id'));
    const out = { ...base };
    for (const k of f) if (!(k in out)) out[k] = k === 'saves' ? 7 : k === 'ctr' ? 1.3 : 99;
    // Another account's row for the same campaign and day comes FIRST: it
    // must not lend its values to this account's row.
    return [{ date: '2026-11-01', account_id: '549999999999', campaign_id: 'pc1', saves: 1000 }, out];
  }, { pinterest: pinCatalog });
  const r = await run(fake, fw, pinAcct);
  assert.equal(r.status, 'success');
  assert.equal(r.mapped_to, 'marketing_kpis_daily');
  const rows = fake.rows('marketing_kpis_daily');
  assert.equal(rows.length, 1, 'only this account\'s campaign row');
  const row = rows[0];
  assert.equal(row.company_entity_id, A);
  assert.equal(row.platform, 'pinterest_ads');
  assert.equal(row.source, 'windsor');
  assert.equal(row.spend, 12);
  assert.equal(row.conversions, 3);
  assert.equal(row.extra.saves, 7, 'a hunted field lands on the row');
  assert.equal(row.extra.ctr, 1.3);
  assert.equal(row.extra.video_p100, 99);
  assert.deepEqual(row.extra._unmapped, ['revenue'], 'a measure the connector lacks is said, not shown as zero');
  assert.equal(row.row_hash, hashRow([A, 'pinterest_ads', 'pinterest_ads', PIN, 'pc1', '2026-11-01']));
  assert.ok(fw.log.every((u) => u.searchParams.get('select_accounts') === PIN), 'every batch is limited to the one account');
});

test('Meta through Windsor never lands in marketing_kpis_daily (SILO syncs it directly)', async () => {
  const acct = { ...pinAcct, id: 'm-f', ds_id: 'facebook' };
  const fake = world([acct]);
  const fw = fakeWindsor(() => [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', campaign: 'Fall', spend: 12, impressions: 3, clicks: 1 }],
    { facebook: pinCatalog });
  const r = await run(fake, fw, acct);
  assert.equal(r.mapped_to, 'windsor_metrics_daily');
  assert.equal(fake.rows('marketing_kpis_daily').length, 0);
  const row = fake.rows('windsor_metrics_daily')[0];
  assert.equal(row.ds_id, 'facebook');
  assert.equal(row.spend, 12);
  assert.equal(row.object_type, 'campaign');
});

test('a non-ad connector lands in windsor_metrics_daily with common columns and NULL for what it lacks', async () => {
  const acct = { id: 'm-y', company_entity_id: A, ds_id: 'yotpo', account_id: 'Y1', account_name: 'A Reviews' };
  const fake = world([acct]);
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('orders')) return [{ date: '2026-11-01', account_id: 'Y1', orders: 5, revenue: '1,200', company_entity_id: B }];
    return [{ date: '2026-11-01', account_id: 'Y1', reviews: 9 }];
  }, { yotpo: [{ id: 'date', type: 'DATE' }, { id: 'account_id', type: 'TEXT' }, { id: 'orders', type: 'NUMERIC', table: 't' },
    { id: 'revenue', type: 'NUMERIC', table: 't' }, { id: 'reviews', type: 'NUMERIC', table: 'r' }] });
  const r = await run(fake, fw, acct);
  assert.equal(r.status, 'success');
  const row = fake.rows('windsor_metrics_daily')[0];
  assert.equal(row.company_entity_id, A);
  assert.equal(row.object_type, 'account');
  assert.equal(row.object_id, '');
  assert.equal(row.orders, 5);
  assert.equal(row.revenue, 1200);
  assert.equal(row.spend, null, 'not reported is NULL, never 0');
  assert.equal(row.metrics.reviews, 9);
  assert.equal(row.row_hash, hashRow([A, 'windsor', 'yotpo', 'Y1', '', '2026-11-01']));
});

test('a hunted field Windsor refuses is recorded by name and not asked again this run; the row still lands', async () => {
  const fake = world([pinAcct]);
  let refusedAsks = 0;
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('video_p100')) { refusedAsks += 1; return { status: 400, text: 'Unknown field: video_p100' }; }
    if (f.includes('spend')) return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', saves: 2 }];
  }, { pinterest: pinCatalog });
  const r = await run(fake, fw, pinAcct, { historyMonths: 3, maxHistoryWindows: 2 });
  assert.equal(r.status, 'success', 'a refused hunted field does not fail the account');
  assert.deepEqual(r.refused_fields, ['video_p100']);
  assert.equal(refusedAsks, 1, 'asked once, then skipped for the rest of the run');
  assert.deepEqual(fake.rows('windsor_linked_accounts')[0].refused_fields, ['video_p100']);
  assert.equal(fake.rows('marketing_kpis_daily')[0].extra.saves, 2);
});

test('a company\'s mapping picks the field for a measure; an unknown field is ignored and said', async () => {
  const fake = world([pinAcct]);
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) {
      assert.ok(f.includes('saves'), 'the chosen field is read with the core fields');
      assert.ok(!f.includes('total_conversions'), 'the automatic pick is replaced, not added');
      return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1, saves: 6, video_p100: 2 }];
    }
    return [];
  }, { pinterest: pinCatalog });
  const r = await run(fake, fw, pinAcct, { overrides: { conversions: 'saves', revenue: 'not_a_field' } });
  const row = fake.rows('marketing_kpis_daily')[0];
  assert.equal(row.conversions, 6);
  assert.deepEqual(r.ignored_mappings, ['revenue']);
});

test('before 20261103080000 is applied: hand-made connectors run as before, others wait, no new column is written', async () => {
  const fake = world([tiktokAcct, pinAcct]);
  const fw = fakeWindsor((c) => (c === 'tiktok' ? [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 2 }] : []),
    { pinterest: pinCatalog });
  const t = await run(fake, fw, tiktokAcct, { anyConnector: false });
  assert.equal(t.status, 'success');
  const p = await run(fake, fw, pinAcct, { anyConnector: false });
  assert.equal(p.status, 'unsupported');
  assert.equal(fake.rows('marketing_kpis_daily').length, 1);
  for (const m of fake.rows('windsor_linked_accounts')) assert.ok(!('refused_fields' in m), 'refused_fields does not exist yet');
});

test('fixed connectors are exactly the ones with a hand-made dataset', async () => {
  const { FIXED_SOURCES } = await import(new URL('../../supabase/functions/windsor-broker/windsor-lib.mjs', import.meta.url));
  assert.deepEqual([...FIXED_SOURCES].sort(), Object.keys(DATASETS).sort());
});

test('a hunted batch refused without naming a field is retried per Windsor table', async () => {
  const fake = world([pinAcct]);
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    if (f.includes('video_p100')) return { status: 400, text: 'incompatible combination' };
    return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', saves: 4, total_conversions: 1, ctr: 2 }];
  }, { pinterest: pinCatalog });
  const r = await run(fake, fw, pinAcct);
  assert.deepEqual(r.refused_fields, ['video_p100'], 'only the table that cannot combine is lost');
  assert.equal(fake.rows('marketing_kpis_daily')[0].extra.saves, 4);
});

test('the call budget stops the run as partial and keeps what landed', async () => {
  const fake = world([klaviyoAcct]);
  const fw = fakeWindsor(() => []);
  const r = await run(fake, fw, klaviyoAcct, { counter: { used: 0, limit: 2 } });
  assert.equal(r.status, 'partial');
  assert.equal(fw.log.length, 2);
});

test('a dry run writes nothing', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor(() => [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 3 }]);
  const r = await run(fake, fw, tiktokAcct, { dryRun: true });
  assert.equal(r.rows_written, 0);
  assert.equal(fake.rows('marketing_kpis_daily').length, 0);
  assert.equal(fake.rows('windsor_linked_accounts')[0].last_sync_status, undefined);
  assert.equal(r.windows[0].datasets.campaign.field_count, 4);
});

test('fieldsNamedIn matches whole field ids and never the required ones', () => {
  const fields = DATASETS.klaviyo[2].fields;
  assert.deepEqual(fieldsNamedIn('Invalid field(s): flow_opens_unique', fields), ['flow_opens_unique']);
  assert.deepEqual(fieldsNamedIn('bad date and account_id', fields), []);
});

test('a refused column field never overwrites a stored value, and that window is not counted as covered', async () => {
  const fake = world([tiktokAcct]);
  const good = fakeWindsor(() => [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 100, impressions: 5 }]);
  await run(fake, good, tiktokAcct);
  assert.equal(fake.rows('marketing_kpis_daily')[0].spend, 100);
  const before = fake.rows('windsor_linked_accounts')[0].synced_through;
  fake.tables.get('windsor_linked_accounts')[0].synced_through = '2026-10-01';
  const refusing = fakeWindsor((c, u) => (u.searchParams.get('fields').split(',').includes('spend')
    ? { status: 400, text: '{"error":"field spend is not available"}' }
    : [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', impressions: 5 }]));
  const r = await run(fake, refusing, tiktokAcct);
  assert.equal(r.status, 'partial');
  assert.equal(fake.rows('marketing_kpis_daily')[0].spend, 100, 'the stored spend survives');
  assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, '2026-10-01', 'the window is not marked covered');
  assert.match(r.windows[0].datasets.campaign.skipped, /spend/);
  assert.ok(before);
});

test('the sync asks TikTok for inactive campaigns too; Klaviyo gets no options', async () => {
  const fake = world([tiktokAcct, klaviyoAcct]);
  const fw = fakeWindsor(() => []);
  await run(fake, fw, tiktokAcct);
  assert.deepEqual(JSON.parse(fw.log[0].searchParams.get('options')), { tiktok: { include_inactive: 'true' } });
  const fk = fakeWindsor(() => []);
  await run(fake, fk, klaviyoAcct);
  assert.ok(fk.log.every((u) => u.searchParams.get('options') === null));
});
