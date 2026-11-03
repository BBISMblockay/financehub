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
//   WINDSOR_SYNC_MUTATION=huntmerge       hunted values are matched without the account (another client's leak in)
//   WINDSOR_SYNC_MUTATION=transient       a timeout / 5xx on a hunted batch counts as a refusal
//   WINDSOR_SYNC_MUTATION=generation      a run under an old mapping saves its cursor over a rewind
//   WINDSOR_SYNC_MUTATION=split           a batch Windsor will not answer whole is not asked in halves
//   WINDSOR_SYNC_MUTATION=outage          fields are dropped as refused even when Windsor answered nothing
//   WINDSOR_SYNC_MUTATION=skiprefused     a refused hunted field is asked again in every window
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
  if (MUT === 'identity') sub('assertAccountRows(rows, accountId, connector);', '');
  if (MUT === 'accountfilter') sub('const { kept, foreign, unattributed } = filterRowsToAccount(rows, accountId, ctx.dsId);', 'const kept = rows; const foreign = 0; const unattributed = 0;');
  if (MUT === 'payloadcompany') sub('const row = dataset.toRow({ ...r, date: day }, ctx);', 'const row = dataset.toRow({ ...r, date: day }, { ...ctx, companyId: r.company_entity_id ?? ctx.companyId });');
  if (MUT === 'selectaccounts') sub('date_from: from, date_to: to, select_accounts: accountId,', 'date_from: from, date_to: to,');
  if (MUT === 'resume') sub("if (w.kind === 'history') historyFrom = w.from;", '');
  if (MUT === 'refusedcolumn') sub('if (blocking.length) {', 'if (false) {');
  if (MUT === 'syncoptions') sub('options: previewOptions(connector),', '');
  if (MUT === 'huntmerge') sub("const mergeId = (dataset, r) => `${r?.account_id ?? ''}\\u0000", "const mergeId = (dataset, r) => `\\u0000");
  if (MUT === 'transient') sub('return r.transient ? readOnce(io) : r;', 'return r.transient ? { ...r, transient: false } : r;');
  if (MUT === 'generation') sub(".eq('mapping_generation', account.mapping_generation)\n", '\n');
  if (MUT === 'split') sub('      await readSplitting({ ...io, fields: batch, state, out });\n      return out;', '      out.incomplete = true;\n      return out;');
  if (MUT === 'outage') sub('    if (state.answered === 0) incomplete = true;\n    else refused.push(...unanswered);', '    refused.push(...unanswered);');
  if (MUT === 'skiprefused') sub('refusedThisRun.add(f);', '');
  if (MUT === 'consent') sub('account.sync_enabled !== true', 'false');
  if (MUT === 'sourcecontract') sub('const datasets = Object.hasOwn(DATASETS, account.ds_id) ? DATASETS[account.ds_id] : null;', 'const datasets = DATASETS[account.ds_id] || DATASETS.tiktok;');
  if (MUT === 'grain') sub("if (byHash.has(row.row_hash)) throw new Error('Ambiguous duplicate row grain; window not saved');", '');
  if (MUT === 'window') sub('|| day < from || day > to)', ')');
  if (MUT === 'huntedgrain') sub('for (const rows of b.rows) validate(rows);', '');
  if (MUT === 'huntunmatched') sub("if (merged.unmatched) throw new Error('Hunted rows do not match the core row grain; window not saved');", '');
  // Absolute imports so the temp copy resolves the repo's modules.
  src = src.replace("'../../supabase/functions/windsor-broker/windsor-lib.mjs'", `'${new URL('../../supabase/functions/windsor-broker/windsor-lib.mjs', libUrl).href}'`)
    .replace("'./shopify-sync-core.mjs'", `'${new URL('./shopify-sync-core.mjs', libUrl).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsor-sync-'));
  const file = path.join(dir, 'windsor-sync-core.mjs');
  fs.writeFileSync(file, src);
  return import(file);
}
const core = await loadCore();
const { syncAccount, planWindows, fieldsNamedIn, DATASETS, MAX_UNANSWERED_PER_WINDOW } = core;

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

const tiktokAcct = { id: 'm-t', sync_enabled: true, company_entity_id: A, ds_id: 'tiktok', account_id: '7000000000000000001', account_name: 'A TikTok' };
const klaviyoAcct = { id: 'm-k', sync_enabled: true, company_entity_id: A, ds_id: 'klaviyo', account_id: 'KA1', account_name: 'A Klaviyo' };

const run = (fake, fw, account, opts = {}) => syncAccount({
  supabase: fake, fetchImpl: fw.fetchImpl, key: KEY, account, now: NOW, historyMonths: 0, maxHistoryWindows: 0, ...opts,
});

test('TikTok lands in marketing_kpis_daily under the mapping row\'s company, this account only', async () => {
  const fake = world([tiktokAcct]);
  const fw = fakeWindsor((c, u) => {
    assert.equal(c, 'tiktok');
    return [
      { date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', campaign: 'Spring', impressions: '1,000', clicks: 12, spend: 5.5, complete_payment: 2, total_complete_payment_rate: 80, reach: 900, company_entity_id: B },
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
  assert.equal(r.status, 'error');
  assert.equal(r.rows_written, 0);
  assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
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

test('an unreviewed connector makes no catalog or data call and is recorded as unsupported', async () => {
  const fake = world([{ ...tiktokAcct, id: 'm-x', ds_id: 'mysql' }]);
  const fw = fakeWindsor(() => []);
  const r = await run(fake, fw, { ...tiktokAcct, id: 'm-x', ds_id: 'mysql' });
  assert.equal(r.status, 'unsupported');
  assert.equal(fw.log.length, 0);
  assert.equal(fw.catalogLog.length, 0);
  assert.match(fake.rows('windsor_linked_accounts')[0].last_sync_error, /row-grain contract/);
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
const pinAcct = { id: 'm-p', company_entity_id: A, ds_id: 'tiktok', sync_enabled: true, account_id: PIN, account_name: 'A Pins' };
const pinCatalog = [
  { id: 'date', type: 'DATE', table: null }, { id: 'account_id', type: 'TEXT' }, { id: 'account_name', type: 'TEXT' },
  { id: 'campaign_id', type: 'TEXT', table: 'Campaign' }, { id: 'campaign', type: 'TEXT', table: 'Campaign' },
  { id: 'spend', type: 'NUMERIC', table: 'Performance' }, { id: 'impressions', type: 'NUMERIC', table: 'Performance' },
  { id: 'clicks', type: 'NUMERIC', table: 'Performance' }, { id: 'total_conversions', type: 'NUMERIC', table: 'Conversions' },
  { id: 'saves', type: 'NUMERIC', table: 'Engagement' }, { id: 'ctr', type: 'PERCENT', table: 'Performance' },
  { id: 'video_p100', type: 'NUMERIC', table: 'Video' },
];

test('a hunted field Windsor refuses is recorded by name and not asked again this run; the row still lands', async () => {
  const fake = world([pinAcct]);
  let refusedAsks = 0;
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('video_p100')) { refusedAsks += 1; return { status: 400, text: 'Unknown field: video_p100' }; }
    if (f.includes('spend')) return [{ date: u.searchParams.get('date_to'), account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    return [{ date: u.searchParams.get('date_to'), account_id: PIN, campaign_id: 'pc1', saves: 2 }];
  }, { tiktok: pinCatalog });
  const r = await run(fake, fw, pinAcct, { historyMonths: 3, maxHistoryWindows: 2 });
  assert.equal(r.status, 'success', 'a refused hunted field does not fail the account');
  assert.deepEqual(r.refused_fields, ['video_p100']);
  assert.equal(refusedAsks, 1, 'asked once, then skipped for the rest of the run');
  assert.deepEqual(fake.rows('windsor_linked_accounts')[0].refused_fields, ['video_p100']);
  assert.equal(fake.rows('marketing_kpis_daily')[0].extra.saves, 2);
});

test('before 20261103080000 is applied: hand-made connectors run as before, others wait, no new column is written', async () => {
  const fake = world([tiktokAcct, pinAcct]);
  const fw = fakeWindsor((c) => (c === 'tiktok' ? [{ date: '2026-11-01', account_id: '7000000000000000001', campaign_id: 'c1', spend: 2 }] : []),
    { tiktok: pinCatalog });
  const t = await run(fake, fw, tiktokAcct, { anyConnector: false });
  assert.equal(t.status, 'success');
  const p = await run(fake, fw, { ...pinAcct, ds_id: 'pinterest' }, { anyConnector: false });
  assert.equal(p.status, 'unsupported');
  assert.equal(fake.rows('marketing_kpis_daily').length, 1);
  for (const m of fake.rows('windsor_linked_accounts')) assert.ok(!('refused_fields' in m), 'refused_fields does not exist yet');
});

test('a hunted batch Windsor does not answer (timeout / 5xx / 429) is not a refusal: stored values and history stay', async () => {
  const acct = { ...pinAcct, history_from: '2026-08-01' };
  const fake = world([acct]);
  let fail = false;
  let failedAsks = 0;
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    if (fail) { failedAsks += 1; return { status: 503, text: 'upstream timeout' }; }
    return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', saves: 7, ctr: 1, video_p100: 3 }];
  }, { tiktok: pinCatalog });
  const first = await run(fake, fw, acct);
  assert.equal(first.status, 'success');
  assert.equal(fake.rows('marketing_kpis_daily')[0].extra.saves, 7);
  fail = true;
  const second = await run(fake, fw, { ...acct, history_from: fake.rows('windsor_linked_accounts')[0].history_from },
    { historyMonths: 6, maxHistoryWindows: 2 });
  assert.equal(second.status, 'partial');
  assert.deepEqual(second.refused_fields, [], 'no answer is not a refusal');
  assert.ok(failedAsks >= 2, 'asked again once before giving up');
  assert.equal(fake.rows('marketing_kpis_daily')[0].extra.saves, 7, 'the stored hunted value is not wiped');
  const m = fake.rows('windsor_linked_accounts')[0];
  assert.equal(m.history_from, '2026-08-01', 'coverage does not advance past a window that was not fully read');
  assert.match(m.last_sync_error, /did not answer/);
});

test('a hunted batch that is too slow as a whole is asked again in halves, and one field that never answers is dropped', async () => {
  const acct = { ...pinAcct, history_from: '2026-08-01' };
  const fake = world([acct]);
  const asks = [];
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) return [{ date: u.searchParams.get('date_to'), account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    asks.push(f);
    // Windsor times out on any ask that includes video_p100.
    if (f.includes('video_p100')) return { status: 504, text: 'gateway timeout' };
    const row = { date: u.searchParams.get('date_to'), account_id: PIN, campaign_id: 'pc1' };
    if (f.includes('saves')) row.saves = 7;
    if (f.includes('ctr')) row.ctr = 1.5;
    return [row];
  }, { tiktok: pinCatalog });
  const r = await run(fake, fw, acct, { historyMonths: 6, maxHistoryWindows: 1 });
  const stored = fake.rows('marketing_kpis_daily').find((x) => x.day_date === '2026-11-02');
  assert.ok(stored, 'the window is written');
  assert.equal(stored.extra.saves, 7, 'fields that answer in a smaller ask are kept');
  assert.equal(stored.extra.ctr, 1.5);
  assert.ok(r.refused_fields.includes('video_p100'), 'the one field Windsor never answers for is listed');
  assert.ok(!r.refused_fields.includes('saves'));
  const m = fake.rows('windsor_linked_accounts')[0];
  assert.ok(m.history_from < '2026-08-01', 'coverage moves on');
  assert.notEqual(r.status, 'error');
  assert.equal(r.unanswered, undefined, 'not left as unanswered');
});

test('when Windsor answers no hunted ask at all, splitting stops early and the window is kept unwritten', async () => {
  const acct = { ...pinAcct, history_from: '2026-08-01' };
  const fake = world([acct]);
  let hunted = 0;
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    hunted += 1;
    return { status: 503, text: 'down' };
  }, { tiktok: pinCatalog });
  const r = await run(fake, fw, acct, { historyMonths: 6, maxHistoryWindows: 1 });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.refused_fields, []);
  assert.equal(fake.rows('marketing_kpis_daily').length, 0);
  assert.ok(hunted <= 2 * (MAX_UNANSWERED_PER_WINDOW + 2), `an outage costs a bounded number of asks (${hunted})`);
});

test('a mapping saved while a run is in flight is not undone by that run', async () => {
  const acct = { ...pinAcct, history_from: '2025-01-01', mapping_generation: 4 };
  const fake = world([acct]);
  const fw = fakeWindsor((c, u) => {
    const f = u.searchParams.get('fields').split(',');
    if (f.includes('spend')) {
      // An admin saves a mapping mid-run: the trigger clears history_from and
      // bumps the generation.
      Object.assign(fake.tables.get('windsor_linked_accounts')[0], { history_from: null, mapping_generation: 5 });
      return [{ date: '2026-11-01', account_id: PIN, campaign_id: 'pc1', spend: 1, impressions: 1, clicks: 1 }];
    }
    return [];
  }, { tiktok: pinCatalog });
  const r = await run(fake, fw, acct, { historyMonths: 6, maxHistoryWindows: 2 });
  const m = fake.rows('windsor_linked_accounts')[0];
  assert.equal(m.history_from, null, 'the rewind stands; the next run re-pulls history under the new mapping');
  assert.equal(m.mapping_generation, 5);
  assert.equal(r.mapping_changed, true);
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
  }, { tiktok: pinCatalog });
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


for (const ds of ['tiktok']) {
  for (const mode of ['mixed', 'mismatched', 'missing']) {
    test(`${ds}: ${mode} identity fails without writes or progress, and retries the same window`, async () => {
      const account = { ...tiktokAcct, ds_id: ds, history_from: '2026-09-01', synced_through: '2026-10-01' };
      const fake = world([account]);
      const own = { account_id: account.account_id, date: '2026-11-01', campaign_id: 'c', impressions: 2 };
      let bad = true;
      const fw = fakeWindsor(() => bad ? (mode === 'mixed' ? [own, { ...own, account_id: 'other' }]
        : [{ ...own, account_id: mode === 'missing' ? null : 'other' }]) : [own],
        { [ds]: [{ id: 'account_id' }, { id: 'date' }, { id: 'impressions', type: 'NUMERIC' }] });
      const result = await run(fake, fw, account, { historyMonths: 2, maxHistoryWindows: 1 });
      assert.equal(result.status, 'error');
      assert.match(result.error, /identity/);
      assert.equal(result.rows_written, 0);
      const stored = fake.rows('windsor_linked_accounts')[0];
      assert.equal(stored.history_from, account.history_from);
      assert.equal(stored.synced_through, account.synced_through);
      assert.equal(stored.last_sync_status, 'error');
      bad = false;
      const retry = await run(fake, fw, account);
      assert.equal(retry.status, 'success');
      assert.equal(fw.log[0].searchParams.get('date_from'), fw.log[1].searchParams.get('date_from'));
    });
  }
}

test('foreign hunted metrics fail before writing core rows or advancing', async () => {
  const fake = world([pinAcct]);
  const fw = fakeWindsor((c, u) => [{ account_id: u.searchParams.get('fields').includes('spend') ? PIN : 'other',
    date: '2026-11-01', campaign_id: 'pc1', spend: 10, saves: 999 }], { tiktok: pinCatalog });
  const result = await run(fake, fw, pinAcct);
  assert.equal(result.status, 'error');
  assert.equal(result.rows_written, 0);
  assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
});

test('prepareRows independently rejects mixed identities', () => {
  assert.throws(() => core.prepareRows([{ account_id: 'other' }], {
    accountId: PIN, from: '2026-11-01', to: '2026-11-02', dataset: DATASETS.tiktok[0], ctx: {},
  }), /identity/);
});

test('hunted merging cannot borrow another account metrics', () => {
  const result = core.mergeHunted({ mergeKey: (r) => r.campaign_id },
    [{ account_id: 'own', date: '2026-11-01', campaign_id: 'c' }],
    [[{ account_id: 'other', date: '2026-11-01', campaign_id: 'c', clicks: 999 }]]);
  assert.equal(result.rows[0].clicks, undefined);
  assert.equal(result.unmatched, 1);
});



for (const ds of ['googlesheets', 'youtube', 'mysql', 'pinterest', 'some_new_source', '__proto__', 'constructor']) {
  test(`${ds}: consent cannot enable an unreviewed arbitrary schema`, async () => {
    const account = { ...tiktokAcct, ds_id: ds, sync_enabled: true, history_from: '2026-01-01' };
    const fake = world([account]);
    const fw = fakeWindsor(() => { throw new Error('Must not fetch unsupported data'); });
    const r = await run(fake, fw, account);
    assert.equal(r.status, 'unsupported');
    assert.equal(r.rows_written, 0);
    assert.equal(fw.catalogLog.length, 0);
    assert.equal(fake.rows('windsor_linked_accounts')[0].history_from, account.history_from);
    assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
  });
}
for (const consent of [false, undefined, null, 'true']) {
  test(`explicit boolean consent required: ${consent}`, async () => {
    const account = { ...tiktokAcct, sync_enabled: consent };
    const fake = world([account]); const fw = fakeWindsor(() => []);
    const r = await run(fake, fw, account);
    assert.equal(r.status, 'paused'); assert.equal(fw.catalogLog.length, 0);
    assert.equal(fake.calls.updates.length, 0);
  });
}
for (const date of [null, undefined, '', '2026-02-30', '2026-11-01T12:30:00Z', '2026-13-01', '2026-11-03']) {
  test(`invalid date ${date} fails before progress`, async () => {
    const fake = world([tiktokAcct]);
    const fw = fakeWindsor(() => [{ account_id: tiktokAcct.account_id, date, campaign_id: 'c', spend: 2 }]);
    const r = await run(fake, fw, tiktokAcct);
    assert.equal(r.status, 'error'); assert.match(r.error, /date/);
    assert.equal(r.rows_written, 0); assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
  });
}
test('distinct same-day campaigns survive, ambiguous same-key text rows fail, retry remains possible', async () => {
  const fake = world([tiktokAcct]);
  const row = { account_id: tiktokAcct.account_id, date: '2026-11-01', campaign_id: 'c1', campaign: 'First', spend: 2 };
  let rows = [row, { ...row, campaign: 'Different text', spend: 3 }];
  const fw = fakeWindsor(() => rows);
  const bad = await run(fake, fw, tiktokAcct);
  assert.equal(bad.status, 'error'); assert.match(bad.error, /grain/);
  assert.equal(bad.rows_written, 0); assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
  rows = [row, { ...row, campaign_id: 'c2', campaign: 'Second' }];
  const good = await run(fake, fw, tiktokAcct);
  assert.equal(good.status, 'success');
  assert.deepEqual(fake.rows('marketing_kpis_daily').map(r => r.campaign_name), ['First', 'Second']);
});
for (const kind of ['duplicate', 'missing-date', 'unmatched']) {
  test(`hunted ${kind} fails before core writes and cursor advancement`, async () => {
    const fake = world([pinAcct]);
    const base = { account_id: PIN, date: '2026-11-01', campaign_id: 'pc1' };
    const fw = fakeWindsor((c, u) => {
      if (u.searchParams.get('fields').includes('spend')) return [{ ...base, spend: 1 }];
      if (kind === 'duplicate') return [{ ...base, saves: 1 }, { ...base, saves: 2 }];
      return [{ ...base, ...(kind === 'missing-date' ? { date: null } : { campaign_id: 'other' }), saves: 9 }];
    }, { tiktok: pinCatalog });
    const r = await run(fake, fw, pinAcct);
    assert.equal(r.status, 'error'); assert.equal(r.rows_written, 0);
    assert.equal(fake.rows('windsor_linked_accounts')[0].synced_through, undefined);
  });
}

test('raw core fetch validates identity before exposing rows to any caller', async () => {
  const fw = fakeWindsor(() => [{ account_id: 'foreign', date: '2026-11-01' }]);
  await assert.rejects(core.fetchDataset({ key: KEY, fetchImpl: fw.fetchImpl, connector: 'tiktok',
    accountId: tiktokAcct.account_id, dataset: DATASETS.tiktok[0], from: '2026-11-01', to: '2026-11-02' }), /identity/);
});

test('missing campaign/flow identity cannot become an account-level row', () => {
  for (const dataset of [DATASETS.tiktok[0], DATASETS.klaviyo[1], DATASETS.klaviyo[2]]) {
    assert.throws(() => core.prepareRows([{ account_id: 'own', date: '2026-11-01', spend: 2 }], {
      accountId: 'own', from: '2026-11-01', to: '2026-11-02', dataset, ctx: { companyId: A, dsId: 'klaviyo' },
    }), /object identity/);
  }
});

test('explicit report text and stable object IDs are not truncated to 500 characters', () => {
  const long = 'x'.repeat(700);
  const row = DATASETS.klaviyo[1].toRow({ date: '2026-11-01', account_id: 'own', campaign_id: long, subject: long }, { companyId: A, accountId: 'own' });
  assert.equal(row.object_id, long); assert.equal(row.attributes.subject, long);
  assert.notEqual(row.row_hash, DATASETS.klaviyo[1].toRow({ date: '2026-11-01', campaign_id: long + 'y' }, { companyId: A, accountId: 'own' }).row_hash);
});
