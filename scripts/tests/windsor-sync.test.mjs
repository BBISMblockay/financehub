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
  const sub = (from, to) => { assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`); src = src.replace(from, to); };
  if (MUT === 'accountfilter') sub('const { kept, foreign, unattributed } = filterRowsToAccount(rows, accountId);', 'const kept = rows; const foreign = 0; const unattributed = 0;');
  if (MUT === 'payloadcompany') sub('const row = dataset.toRow({ ...r, date: day }, ctx);', 'const row = dataset.toRow({ ...r, date: day }, { ...ctx, companyId: r.company_entity_id ?? ctx.companyId });');
  if (MUT === 'selectaccounts') sub('date_from: from, date_to: to, select_accounts: accountId,', 'date_from: from, date_to: to,');
  if (MUT === 'resume') sub("if (w.kind === 'history') historyFrom = w.from;", '');
  if (MUT === 'window') sub("if (!DATE_RE.test(day) || day < from || day > to) { outOfWindow += 1; continue; }", "if (!DATE_RE.test(day)) { outOfWindow += 1; continue; }");
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
function fakeWindsor(rowsFor) {
  const log = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    log.push(u);
    const connector = u.pathname.slice(1);
    const out = rowsFor(connector, u);
    if (out && out.status) return { ok: false, status: out.status, text: async () => out.text };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: out ?? [] }) };
  };
  return { fetchImpl, log };
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

test('an unsupported source makes no Windsor call and is recorded', async () => {
  const fake = world([{ ...tiktokAcct, id: 'm-x', ds_id: 'mysql' }]);
  const fw = fakeWindsor(() => []);
  const r = await run(fake, fw, { ...tiktokAcct, id: 'm-x', ds_id: 'mysql' });
  assert.equal(r.status, 'unsupported');
  assert.equal(fw.log.length, 0);
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
  assert.deepEqual(r.windows[0].datasets.campaign.sample_keys, ['account_id', 'campaign_id', 'date', 'spend']);
});

test('fieldsNamedIn matches whole field ids and never the required ones', () => {
  const fields = DATASETS.klaviyo[2].fields;
  assert.deepEqual(fieldsNamedIn('Invalid field(s): flow_opens_unique', fields), ['flow_opens_unique']);
  assert.deepEqual(fieldsNamedIn('bad date and account_id', fields), []);
});
