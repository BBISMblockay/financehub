/* Redo marketing sync core, driven end to end with a fake Redo GraphQL
 * endpoint and a fake Supabase that stores rows and applies filters.
 *
 * What this pins, and why each matters:
 *   1. Rows are one per message x channel x day, straight from
 *      series[].byChannel -- counts only, money kept as the exact decimal
 *      string Redo sent (never a float).
 *   2. Every page is fetched (the cursor is echoed back) for BOTH lists.
 *   3. Campaigns are fetched with NO send-date filter and automations with
 *      NO `enabled` filter. Both filters were measured to drop real
 *      attributed revenue (2026-09-24: $4,309 from campaigns sent up to six
 *      weeks before the window; paused automations still attribute).
 *   4. A failure on page 2 writes NOTHING and sweeps NOTHING. The sweep
 *      trusts that the fetch was complete; a partial fetch must never reach it.
 *   5. The sweep removes only this company's rows, inside the window, older
 *      than this run -- never another tenant's, never outside the window,
 *      never a newer run's.
 *   6. INSUFFICIENT_SCOPE is classified (a configuration state the driver
 *      records as skipped), 401 is an error, THROTTLED is retried.
 *   7. Windows: default ends YESTERDAY in the business timezone; >400 days
 *      is chunked newest-first; a >400-day window is refused unchunked.
 *   8. The per-connection driver (the path the workflow actually runs):
 *      every outcome is told apart by the sync_jobs row alone -- success,
 *      skipped for a missing scope (not a failure), error (rethrown), and an
 *      unconfigured connection that never opens a job -- and a backfill that
 *      fails part-way lists the chunks it did write.
 *
 * Run: node scripts/tests/redo-marketing-sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './lib/fake-supabase.mjs';
import {
  AUTOMATIONS_QUERY, CAMPAIGNS_QUERY, RedoApiError, chunkWindow, isScopeError,
  redoGraphql, resolveWindow, syncRedoMarketingConnection, syncRedoMarketingWindow,
} from '../lib/redo-marketing-sync-core.mjs';

const CO = 'company-a';
const OTHER = 'company-b';
const noSleep = async () => {};

const point = (channel, over = {}) => ({
  channel, recipients: 10, sends: 10, delivered: 9, failures: 1, uniqueOpens: channel === 'SMS' ? 0 : 5,
  uniqueClicks: 2, unsubscribes: 0, orders: 1, newCustomerOrders: 1, returningCustomerOrders: 0,
  revenue: { amount: '100.10', currency: 'USD' }, newCustomerRevenue: { amount: '100.10', currency: 'USD' },
  returningCustomerRevenue: { amount: '0.00', currency: 'USD' }, spend: { amount: '0.0060', currency: 'USD' },
  ...over,
});
const node = (id, series, extra = {}) => ({
  id, legacyId: `legacy-${id}`, name: `Message ${id}`, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z',
  analytics: { messaging: { series } }, ...extra,
});

/** A Redo that serves fixed pages and records every request it received. */
function fakeRedo({ campaignPages, automationPages, failOn = null, responses = null }) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, auth: init.headers.Authorization, ...body });
    if (responses) {
      const next = responses.shift();
      return { status: next.status, ok: next.status < 400, text: async () => JSON.stringify(next.body) };
    }
    const isCampaigns = body.query === CAMPAIGNS_QUERY;
    const pages = isCampaigns ? campaignPages : automationPages;
    const index = body.variables.after ? Number(body.variables.after.replace('cursor-', '')) : 0;
    if (failOn && failOn.list === (isCampaigns ? 'campaigns' : 'automations') && failOn.page === index + 1) {
      return { status: 500, ok: false, text: async () => 'upstream exploded' };
    }
    const field = isCampaigns ? 'campaigns' : 'marketingAutomations';
    const hasNextPage = index + 1 < pages.length;
    return {
      status: 200, ok: true,
      text: async () => JSON.stringify({
        data: { [field]: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${index + 1}` : null }, nodes: pages[index] } },
        extensions: { cost: { actualQueryCost: 7 } },
      }),
    };
  };
  return { fetchImpl, requests };
}

const WINDOW = { startDate: '2026-09-01', endDate: '2026-09-10' };
const run = (supabase, redo, over = {}) => syncRedoMarketingWindow({
  supabase, companyEntityId: CO, connectionId: 'conn-1', token: 'tok', storeId: 'store-1',
  ...WINDOW, syncedAt: '2026-09-11T10:45:00.000Z', fetchImpl: redo.fetchImpl, sleep: noSleep, ...over,
});

test('maps series[].byChannel to one row per message x channel x day, counts and exact money', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({
    campaignPages: [[node('c1', [{ date: '2026-09-02', byChannel: [point('EMAIL')] }], {
      channel: 'EMAIL', status: 'FINISHED', sentAt: '2026-09-02T17:00:00Z', tags: [],
      emailVariants: [{ position: 1, abTestWeight: 0.5, template: { subject: 'B', previewText: 'pb' } },
        { position: 0, abTestWeight: 0.5, template: { subject: 'A', previewText: 'pa' } }],
    })]],
    automationPages: [[node('a1', [{ date: '2026-09-03', byChannel: [point('EMAIL'), point('SMS', { revenue: { amount: '39533.52', currency: 'USD' } })] }], {
      category: 'MARKETING', enabled: false,
    })]],
  });
  const result = await run(supabase, redo);

  const daily = supabase.rows('redo_marketing_daily');
  assert.equal(daily.length, 3);
  const sms = daily.find((r) => r.redo_id === 'a1' && r.channel === 'SMS');
  assert.equal(sms.revenue, '39533.52', 'money stays the exact decimal string');
  assert.equal(typeof sms.revenue, 'string');
  assert.equal(sms.unique_opens, 0);
  assert.equal(sms.kind, 'automation');
  assert.equal(sms.day_date, '2026-09-03');
  assert.equal(sms.synced_at, '2026-09-11T10:45:00.000Z');
  assert.equal(sms.spend_currency, 'USD');
  assert.equal(sms.attribution_window_days, 5);
  assert.ok(!Object.keys(sms).some((k) => /rate/.test(k)), 'no rate is stored -- rates belong to a window');

  const msgs = supabase.rows('redo_marketing_messages');
  const c1 = msgs.find((m) => m.redo_id === 'c1');
  assert.equal(c1.subject, 'A', 'subject is the variant at position 0, not array order');
  assert.equal(c1.channel, 'EMAIL');
  assert.equal(c1.legacy_id, 'legacy-c1');
  const a1 = msgs.find((m) => m.redo_id === 'a1');
  assert.equal(a1.enabled, false, 'a paused automation is kept');
  assert.equal(a1.channel, null, 'an automation has no single channel');

  assert.equal(result.campaigns_returned, 1);
  assert.equal(result.automations_returned, 1);
  assert.equal(result.daily_rows_upserted, 3);
  assert.equal(result.api_cost, 14);
});

test('pages both lists to the end and filters neither by send date nor by enabled', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({
    campaignPages: [[node('c1', [])], [node('c2', [])], [node('c3', [])]],
    automationPages: [[node('a1', [])], [node('a2', [])]],
  });
  const result = await run(supabase, redo);
  assert.equal(result.campaigns_returned, 3);
  assert.equal(result.automations_returned, 2);

  const campaignReqs = redo.requests.filter((r) => r.query === CAMPAIGNS_QUERY);
  assert.deepEqual(campaignReqs.map((r) => r.variables.after), [null, 'cursor-1', 'cursor-2']);
  for (const r of campaignReqs) {
    assert.equal(r.variables.first, 100);
    assert.equal(r.variables.start, '2026-09-01');
    assert.equal(r.variables.end, '2026-09-10');
    assert.equal(r.variables.window, 5);
    assert.ok(!('sentAfter' in r.variables), 'no send-date filter variable');
  }
  assert.doesNotMatch(CAMPAIGNS_QUERY, /sentAfter|sentBefore/);
  assert.doesNotMatch(AUTOMATIONS_QUERY, /enabled:/);
  assert.equal(redo.requests.filter((r) => r.query === AUTOMATIONS_QUERY).length, 2);
  assert.ok(redo.requests.every((r) => r.url.endsWith('/v3/account/store-1/graphql') && r.auth === 'Bearer tok'));
});

test('a failure on a later page writes nothing and sweeps nothing', async () => {
  const supabase = createFakeSupabase();
  await supabase.from('redo_marketing_daily').upsert([
    { company_entity_id: CO, kind: 'campaign', redo_id: 'old', channel: 'EMAIL', day_date: '2026-09-05', synced_at: '2026-09-01T00:00:00.000Z' },
  ], { onConflict: 'company_entity_id,kind,redo_id,channel,day_date' });
  for (const failOn of [{ list: 'campaigns', page: 2 }, { list: 'automations', page: 2 }]) {
    const redo = fakeRedo({
      campaignPages: [[node('c1', [{ date: '2026-09-02', byChannel: [point('EMAIL')] }])], [node('c2', [])]],
      automationPages: [[node('a1', [])], [node('a2', [])]],
      failOn,
    });
    await assert.rejects(run(supabase, redo), /HTTP 500/);
  }
  assert.equal(supabase.calls.deletes.length, 0, 'no sweep ran');
  assert.equal(supabase.rows('redo_marketing_messages').length, 0, 'no message was written');
  assert.deepEqual(supabase.rows('redo_marketing_daily').map((r) => r.redo_id), ['old'], 'the stored row survives');
});

test('the sweep retires only this company, inside the window, older than this run', async () => {
  const supabase = createFakeSupabase();
  const key = { onConflict: 'company_entity_id,kind,redo_id,channel,day_date' };
  const row = (company, redoId, day, syncedAt) => ({
    company_entity_id: company, kind: 'campaign', redo_id: redoId, channel: 'EMAIL', day_date: day, synced_at: syncedAt,
  });
  await supabase.from('redo_marketing_daily').upsert([
    row(CO, 'restated-away', '2026-09-04', '2026-09-10T10:45:00.000Z'), // in window, older, not returned -> removed
    row(CO, 'before-window', '2026-08-31', '2026-09-10T10:45:00.000Z'), // outside window -> kept
    row(CO, 'after-window', '2026-09-11', '2026-09-10T10:45:00.000Z'), // outside window -> kept
    row(CO, 'newer-run', '2026-09-05', '2026-09-11T11:00:00.000Z'), // a NEWER run's row -> kept
    row(OTHER, 'other-tenant', '2026-09-04', '2026-09-10T10:45:00.000Z'), // other company -> kept
  ], key);
  const redo = fakeRedo({
    campaignPages: [[node('c1', [{ date: '2026-09-02', byChannel: [point('EMAIL')] }])]],
    automationPages: [[]],
  });
  const result = await run(supabase, redo);
  assert.equal(result.stale_rows_removed, 1);
  assert.deepEqual(
    supabase.rows('redo_marketing_daily').map((r) => r.redo_id).sort(),
    ['after-window', 'before-window', 'c1', 'newer-run', 'other-tenant'],
  );
});

test('a series day outside the requested window is never written', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({
    campaignPages: [[node('c1', [
      { date: '2026-08-31', byChannel: [point('EMAIL')] },
      { date: '2026-09-01', byChannel: [point('EMAIL')] },
      { date: '2026-09-11', byChannel: [point('EMAIL')] },
    ])]],
    automationPages: [[]],
  });
  await run(supabase, redo);
  assert.deepEqual(supabase.rows('redo_marketing_daily').map((r) => r.day_date), ['2026-09-01']);
});

test('an unparseable money amount fails loudly rather than storing a guess', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({
    campaignPages: [[node('c1', [{ date: '2026-09-02', byChannel: [point('EMAIL', { revenue: { amount: '1,234.00', currency: 'USD' } })] }])]],
    automationPages: [[]],
  });
  await assert.rejects(run(supabase, redo), /unparseable Redo amount/);
  assert.equal(supabase.rows('redo_marketing_daily').length, 0);
});

test('error classification: scope is a config state, 401 is an error, throttling is retried', async () => {
  const conn = { token: 't', storeId: 's', query: '{x}', variables: {}, sleep: noSleep };

  const scope = fakeRedo({ responses: [{ status: 200, body: { errors: [{ message: 'missing scope', extensions: { code: 'INSUFFICIENT_SCOPE' } }] } }] });
  const scopeErr = await redoGraphql({ ...conn, fetchImpl: scope.fetchImpl }).catch((e) => e);
  assert.ok(isScopeError(scopeErr), 'INSUFFICIENT_SCOPE is recognised');

  // One query touching several scoped fields can return several errors; the
  // scope error must win even when it is not listed first, or a missing scope
  // would read as an outage and turn the nightly red.
  const mixed = fakeRedo({ responses: [{ status: 200, body: { errors: [
    { message: 'field failed', path: ['campaigns'] },
    { message: 'missing scope', extensions: { code: 'INSUFFICIENT_SCOPE' } },
  ] } }] });
  assert.ok(isScopeError(await redoGraphql({ ...conn, fetchImpl: mixed.fetchImpl }).catch((e) => e)));

  const unauth = fakeRedo({ responses: [{ status: 401, body: { errors: [{ message: 'Unauthorized' }] } }] });
  const unauthErr = await redoGraphql({ ...conn, fetchImpl: unauth.fetchImpl }).catch((e) => e);
  assert.ok(unauthErr instanceof RedoApiError && unauthErr.status === 401);
  assert.ok(!isScopeError(unauthErr), 'a bad token is not a missing scope');

  const throttled = fakeRedo({ responses: [
    { status: 200, body: { errors: [{ message: 'slow down', extensions: { code: 'THROTTLED' } }] } },
    { status: 200, body: { data: { ok: true }, extensions: { cost: { actualQueryCost: 3 } } } },
  ] });
  const ok = await redoGraphql({ ...conn, fetchImpl: throttled.fetchImpl });
  assert.deepEqual(ok.data, { ok: true });
  assert.equal(throttled.requests.length, 2);

  const alwaysThrottled = fakeRedo({ responses: Array.from({ length: 3 }, () => ({ status: 429, body: {} })) });
  const gaveUp = await redoGraphql({ ...conn, fetchImpl: alwaysThrottled.fetchImpl, maxThrottleRetries: 2 }).catch((e) => e);
  assert.equal(gaveUp.code, 'THROTTLED');
});

test('a scope failure mid-fetch still writes nothing', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({ responses: [
    { status: 200, body: { data: { campaigns: { pageInfo: { hasNextPage: false }, nodes: [node('c1', [{ date: '2026-09-02', byChannel: [point('EMAIL')] }])] } } } },
    { status: 200, body: { errors: [{ message: 'no', extensions: { code: 'INSUFFICIENT_SCOPE' } }] } },
  ] });
  const err = await run(supabase, redo).catch((e) => e);
  assert.ok(isScopeError(err));
  assert.equal(supabase.rows('redo_marketing_daily').length, 0);
  assert.equal(supabase.calls.deletes.length, 0);
});

test('windows: yesterday in the business timezone, explicit dates win, bad input refused', () => {
  // 2026-09-24 05:00 UTC is still 2026-09-23 in Los Angeles -> yesterday is 09-22.
  const now = new Date('2026-09-24T05:00:00Z');
  assert.deepEqual(resolveWindow({ now, timeZone: 'America/Los_Angeles', daysBack: 60 }),
    { startDate: '2026-07-25', endDate: '2026-09-22' });
  assert.deepEqual(resolveWindow({ now, timeZone: 'UTC', daysBack: 1 }),
    { startDate: '2026-09-23', endDate: '2026-09-23' });
  assert.deepEqual(resolveWindow({ now, timeZone: 'America/Los_Angeles', startDate: '2025-01-01', endDate: '2025-01-31' }),
    { startDate: '2025-01-01', endDate: '2025-01-31' });
  assert.throws(() => resolveWindow({ now, timeZone: 'UTC', daysBack: 0 }), /positive integer/);
  assert.throws(() => resolveWindow({ now, timeZone: 'UTC', startDate: '2026/01/01' }), /YYYY-MM-DD/);
  assert.throws(() => resolveWindow({ now, timeZone: 'UTC', startDate: '2026-09-10', endDate: '2026-09-01' }), /after end/);
});

test('long windows are chunked newest-first within the 400-day limit, and refused unchunked', async () => {
  const chunks = chunkWindow({ startDate: '2024-01-01', endDate: '2026-09-22' });
  assert.equal(chunks[0].endDate, '2026-09-22', 'newest first');
  assert.equal(chunks.at(-1).startDate, '2024-01-01');
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const days = (Date.parse(c.endDate) - Date.parse(c.startDate)) / 86400000 + 1;
    assert.ok(days >= 1 && days <= 400, `chunk ${c.startDate}..${c.endDate} is ${days} days`);
    if (i > 0) {
      const gap = (Date.parse(chunks[i - 1].startDate) - Date.parse(c.endDate)) / 86400000;
      assert.equal(gap, 1, 'chunks are contiguous, no day skipped or repeated');
    }
  }
  assert.deepEqual(chunkWindow({ startDate: '2026-09-01', endDate: '2026-09-01' }), [{ startDate: '2026-09-01', endDate: '2026-09-01' }]);

  const supabase = createFakeSupabase();
  const redo = fakeRedo({ campaignPages: [[]], automationPages: [[]] });
  await assert.rejects(run(supabase, redo, { startDate: '2025-01-01', endDate: '2026-09-01' }), /exceeds Redo's 400-day limit/);
  assert.equal(redo.requests.length, 0);
});

// ── the per-connection driver ──────────────────────────────────────────────

const connection = (over = {}) => ({
  id: 'conn-1', company_entity_id: CO, api_secret: 'tok', meta: { redo_store_id: 'store-1' }, ...over,
});
const clock = () => { let t = Date.parse('2026-09-24T10:45:00.000Z'); return () => new Date(t += 1000); };
const ok = (field, nodes) => ({ status: 200, body: { data: { [field]: { pageInfo: { hasNextPage: false }, nodes } } } });
const scopeFail = { status: 200, body: { errors: [{ message: 'nope', extensions: { code: 'INSUFFICIENT_SCOPE' } }] } };

test('driver: success records one job with the window, timezone and chunk counts', async () => {
  const supabase = createFakeSupabase();
  await supabase.from('company_settings').insert({ company_entity_id: CO, business_timezone: 'UTC' });
  const redo = fakeRedo({ campaignPages: [[node('c1', [{ date: '2026-09-22', byChannel: [point('EMAIL')] }])]], automationPages: [[]] });
  const out = await syncRedoMarketingConnection({
    supabase, connection: connection(), daysBack: '3', now: clock(), fetchImpl: redo.fetchImpl, sleep: noSleep,
  });
  // UTC, 2026-09-24 -> yesterday 09-23, three days back.
  assert.deepEqual(out.window, { startDate: '2026-09-21', endDate: '2026-09-23' });
  const [job] = supabase.rows('sync_jobs');
  assert.equal(job.job_type, 'redo_marketing');
  assert.equal(job.status, 'success');
  assert.equal(job.company_entity_id, CO);
  assert.equal(job.result.time_zone, 'UTC');
  assert.equal(job.result.chunks.length, 1);
  assert.equal(job.result.chunks[0].daily_rows_upserted, 1);
  assert.ok(job.finished_at);
  assert.equal(supabase.rows('redo_marketing_daily')[0].connection_id, 'conn-1');
});

test('driver: falls back to Pacific when the company has no business timezone', async () => {
  const supabase = createFakeSupabase();
  const redo = fakeRedo({ campaignPages: [[]], automationPages: [[]] });
  const out = await syncRedoMarketingConnection({
    supabase, connection: connection(), daysBack: '1',
    now: () => new Date('2026-09-24T05:00:00Z'), fetchImpl: redo.fetchImpl, sleep: noSleep,
  });
  assert.deepEqual(out.window, { startDate: '2026-09-22', endDate: '2026-09-22' }, 'Pacific yesterday, not UTC yesterday');
});

test('driver: a missing scope is SKIPPED, not failed, and keeps the chunks already written', async () => {
  const supabase = createFakeSupabase();
  await supabase.from('company_settings').insert({ company_entity_id: CO, business_timezone: 'UTC' });
  // 500 days -> two chunks. The newest succeeds; the older one hits a scope error.
  const redo = fakeRedo({ responses: [ok('campaigns', []), ok('marketingAutomations', []), scopeFail] });
  const out = await syncRedoMarketingConnection({
    supabase, connection: connection(), startDate: '2025-05-01', endDate: '2026-09-22',
    now: clock(), fetchImpl: redo.fetchImpl, sleep: noSleep,
  });
  assert.equal(out.skipped, 'insufficient_scope');
  const [job] = supabase.rows('sync_jobs');
  assert.equal(job.status, 'skipped');
  assert.match(job.error, /lacks a marketing scope/);
  assert.equal(job.result.chunks.length, 1, 'the chunk that landed is recorded');
  assert.equal(job.result.chunks[0].window.endDate, '2026-09-22');
});

test('driver: any other failure is an ERROR, rethrown, with the partial chunks recorded', async () => {
  const supabase = createFakeSupabase();
  await supabase.from('company_settings').insert({ company_entity_id: CO, business_timezone: 'UTC' });
  const redo = fakeRedo({ responses: [ok('campaigns', []), ok('marketingAutomations', []), { status: 502, body: { message: 'bad gateway' } }] });
  await assert.rejects(syncRedoMarketingConnection({
    supabase, connection: connection(), startDate: '2025-05-01', endDate: '2026-09-22',
    now: clock(), fetchImpl: redo.fetchImpl, sleep: noSleep,
  }), /HTTP 502/);
  const [job] = supabase.rows('sync_jobs');
  assert.equal(job.status, 'error');
  assert.match(job.error, /HTTP 502/);
  assert.equal(job.result.chunks.length, 1);
});

test('driver: an unconfigured connection opens no job and calls nothing', async () => {
  for (const conn of [connection({ api_secret: null }), connection({ meta: {} })]) {
    const supabase = createFakeSupabase();
    const redo = fakeRedo({ campaignPages: [[]], automationPages: [[]] });
    const out = await syncRedoMarketingConnection({ supabase, connection: conn, now: clock(), fetchImpl: redo.fetchImpl });
    assert.equal(out.skipped, 'not_configured');
    assert.equal(supabase.rows('sync_jobs').length, 0);
    assert.equal(redo.requests.length, 0);
  }
});
