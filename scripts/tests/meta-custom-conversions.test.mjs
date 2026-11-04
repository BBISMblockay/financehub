// Meta custom conversions: the events the sync used to read and throw away.
//
// Meta's insights `actions` array carries every event an ad fired, but the
// sync picks a fixed list of names out of it (purchase, view_content,
// add_to_cart, initiate_checkout, thruplays, leads). A custom conversion --
// Baseballism's "Black Friday 2026 Sign ups", for one -- arrives as
// `offsite_conversion.custom.<id>`, matches none of those names, and was
// dropped on every run, which is why a column visible in Ads Manager existed
// nowhere in SILO.
//
// What these tests defend:
//   1. ADDITIVE. The new write cannot cost the old one. A custom-conversion
//      failure -- no table yet, no permission, Meta refusing the lookup --
//      must leave marketing_kpis_daily and meta_ad_performance_daily written
//      exactly as before. This is the whole promise of the change.
//   2. No new insights FIELD is requested. Meta rejects an entire insights
//      request on one bad field name, so taking the events out of the response
//      already fetched is what keeps spend and ROAS safe.
//   3. Custom conversions are never summed into `conversions`. They overlap
//      purchases, and adding them would inflate every report and every bot.
//   4. row_hash is identity only (company x level x account x object x day x
//      action_type) -- Meta restates these numbers for weeks, and a hash over
//      the values would write a second row instead of correcting the first.
//   5. A day Meta did not report the event writes NO row. Zero would read as
//      "measured zero" rather than "not reported".
//   6. Campaign-level and ad-level rows stay distinguishable, because they
//      describe the same conversions over the same spend and summing both
//      double counts.
//
// Reach and frequency (20261104001000) ride on the same insights response and
// are tested here too: they are requested behind a degrade guard, because a
// field name Meta refuses kills the WHOLE request, and they are stored null
// rather than 0 when Meta does not report them.
//
// Mutation-tested: each guard is broken in turn and a test must fail. Run
//   node scripts/tests/meta-custom-conversions.test.mjs --mutate=N
// for N in 1..8; every one must exit non-zero.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs');
const mutation = Number((process.argv.find((a) => a.startsWith('--mutate=')) || '').split('=')[1] || 0);

let source = readFileSync(CORE, 'utf8');
if (mutation === 1) {
  // Keep every action, not only the custom ones: purchases would be stored
  // twice, once as a purchase and once as a "custom" conversion.
  source = source.replace('if (!CUSTOM_ACTION_RE.test(type)) continue;', 'if (!type) continue;');
} else if (mutation === 2) {
  // Let a custom-conversion write failure escape and fail the whole sync.
  source = source.replace(
    "  } catch (err) {\n    report.warning = `custom conversions not stored: ${err.message}`;\n    console.warn('[warn] Meta custom conversions not stored:', err.message);\n  }",
    '  } catch (err) { throw err; }');
} else if (mutation === 3) {
  // Put the measured values into the identity hash: a restatement would then
  // insert a second row instead of correcting the first.
  source = source.replace(
    "          connection.company_entity_id, 'meta_custom_conv', level,\n          r.accountId, objectId, r.day, c.actionType,",
    "          connection.company_entity_id, 'meta_custom_conv', level,\n          r.accountId, objectId, r.day, c.actionType, c.conversions, c.conversionValue,");
} else if (mutation === 4) {
  // Write a row for an event Meta did not report.
  source = source.replace('if (!c.conversions && !c.conversionValue) continue;', 'if (false) continue;');
} else if (mutation === 6) {
  // Read a missing reach as 0 instead of null: "not reported" becomes
  // "reached nobody", which is a measurement nobody took.
  source = source.replace(
    'function metaReach(row) {\n  const n = Number(row?.reach);\n  return Number.isFinite(n) ? Math.round(n) : null;',
    'function metaReach(row) {\n  const n = Number(row?.reach);\n  return Number.isFinite(n) ? Math.round(n) : 0;');
} else if (mutation === 7) {
  // Remove the reach/frequency degrade at campaign level: a refused field name
  // then takes down spend with it.
  source = source.replace(
    "        if (withReachFrequency && isMetaUnknownFieldError(err)) {\n          console.warn('[warn] Meta rejected reach/frequency, retrying without them:', err.message);\n          withReachFrequency = false;\n          url = buildUrl();\n          continue;\n        }\n",
    '');
} else if (mutation === 8) {
  // Remove the missing-column fallback: a database where the reach/frequency
  // migration has not been applied yet then stops storing spend entirely.
  source = source.replace(
    "    if (!missing.length || !looksLikeMissingColumn) throw err;",
    '    if (true) throw err;');
} else if (mutation === 5) {
  // Collapse the two grains onto one identity, so campaign and ad rows
  // overwrite each other instead of staying separable.
  source = source.replace(
    "connection.company_entity_id, 'meta_custom_conv', level,",
    "connection.company_entity_id, 'meta_custom_conv',");
}
if (mutation) assert.notEqual(source, readFileSync(CORE, 'utf8'), 'mutation did not apply');

const dir = mkdtempSync(join(tmpdir(), 'meta-custom-conv-'));
const sibling = pathToFileURL(join(ROOT, 'scripts/lib/shopify-sync-core.mjs')).href;
const copy = join(dir, 'ad-platforms-sync-core.mjs');
writeFileSync(copy, source.replace("from './shopify-sync-core.mjs'", `from '${sibling}'`));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const {
  collectCustomConversions, customConversionRows, writeMetaCustomConversions,
  runConnectionSync, runMetaAdLevelSync,
} = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CONN = {
  id: 'conn-1',
  company_entity_id: 'co-1',
  platform: 'meta_ads',
  access_token: 'tok',
  meta_ad_account_id: 'act_123',
};

/** An insights row shaped like Meta's, with one standard purchase and two
 * custom events -- a custom conversion (by id) and a custom pixel event. */
const INSIGHT = {
  account_id: 'act_123',
  account_name: 'Demo',
  date_start: '2026-11-01',
  campaign_id: 'c1',
  campaign_name: 'Early Bird 2026',
  adset_id: 'as1',
  adset_name: 'Prospecting',
  ad_id: 'a1',
  ad_name: 'Snowing Back Baseball Glasses Vec Static',
  impressions: '1000',
  clicks: '50',
  spend: '123.45',
  reach: '780',
  frequency: '1.2821',
  actions: [
    { action_type: 'omni_purchase', value: '6' },
    { action_type: 'offsite_conversion.custom.987654321', value: '207' },
    { action_type: 'offsite_conversion.fb_pixel_custom.NewsletterSignup', value: '12' },
  ],
  action_values: [
    { action_type: 'omni_purchase', value: '540.00' },
    { action_type: 'offsite_conversion.custom.987654321', value: '0' },
  ],
};

function withFetch(routes) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ path, params: u.searchParams });
    for (const [key, handler] of Object.entries(routes)) {
      if (path === key) {
        const r = await handler(u.searchParams);
        if (r instanceof Error) {
          return new Response(JSON.stringify({ error: { message: r.message, code: 100 } }), { status: 400 });
        }
        return new Response(JSON.stringify(r), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: { message: `(#100) Unsupported get request for ${path}`, code: 100 } }), { status: 400 });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

/** `failTables` makes exactly those tables reject the write, which is how a
 * database without the migration applied behaves for the new tables. */
function fakeSupabase({ failTables = [] } = {}) {
  const writes = [];
  const api = {
    from(table) {
      const b = {
        upsert(payload) {
          if (failTables.includes(table)) {
            return Promise.resolve({ data: null, error: { message: `relation "public.${table}" does not exist` } });
          }
          writes.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        },
        select() { return b; },
        eq() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return b;
    },
  };
  return { api, writes };
}
const rowsFor = (writes, table) => writes.filter((w) => w.table === table).flatMap((w) => w.payload);

// ── 1. Reading the events out of the response ───────────────────────────────
await test('collect: custom conversions and custom pixel events, and nothing else', () => {
  const got = collectCustomConversions(INSIGHT);
  assert.deepEqual(got.map((c) => c.actionType), [
    'offsite_conversion.custom.987654321',
    'offsite_conversion.fb_pixel_custom.NewsletterSignup',
  ]);
  // The purchase is NOT among them: it already has its own column, and
  // counting it twice is the failure this excludes.
  assert.ok(!got.some((c) => c.actionType.includes('purchase')));
  assert.equal(got[0].conversions, 207);
  assert.equal(got[0].customConversionId, '987654321');
  // A pixel custom event is named by its event, not by an id -- inventing one
  // would join it to some other conversion's name.
  assert.equal(got[1].customConversionId, null);
  assert.equal(got[1].conversionValue, 0, 'no action_values entry means no value, not NaN');
});

await test('collect: a repeated action_type is counted once, not summed', () => {
  const got = collectCustomConversions({
    actions: [
      { action_type: 'offsite_conversion.custom.1', value: '5' },
      { action_type: 'offsite_conversion.custom.1', value: '5' },
    ],
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].conversions, 5);
});

await test('collect: a row with no actions is empty, never a throw', () => {
  assert.deepEqual(collectCustomConversions({}), []);
  assert.deepEqual(collectCustomConversions(null), []);
});

// ── 2. The rows ─────────────────────────────────────────────────────────────
await test('rows: identity only in row_hash, so a restatement updates in place', () => {
  const opts = { level: 'campaign', syncedAt: 'now', batchId: 'b1' };
  const raw = [{ ...INSIGHT, day: '2026-11-01', accountId: 'act_123', campaignId: 'c1', customConversions: collectCustomConversions(INSIGHT) }];
  const first = customConversionRows(CONN, raw, opts);
  const restated = customConversionRows(CONN, [{
    ...raw[0],
    customConversions: raw[0].customConversions.map((c) => ({ ...c, conversions: c.conversions + 9 })),
  }], opts);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((r) => r.row_hash), restated.map((r) => r.row_hash));
  assert.notEqual(first[0].conversions, restated[0].conversions);
});

await test('rows: the two grains never collide, and an ad row carries its ad', () => {
  const raw = [{ ...INSIGHT, day: '2026-11-01', accountId: 'act_123', campaignId: 'c1', adId: 'a1', adName: 'Ad One', customConversions: collectCustomConversions(INSIGHT) }];
  const campaign = customConversionRows(CONN, raw, { level: 'campaign', syncedAt: 'now' });
  const ad = customConversionRows(CONN, raw, { level: 'ad', syncedAt: 'now' });
  assert.notEqual(campaign[0].row_hash, ad[0].row_hash, 'campaign and ad rows must not overwrite each other');
  // And they must stay apart on the identity itself, not merely because a
  // campaign id usually differs from an ad id: Meta's ids are only unique
  // within their own object type, so `level` has to be part of the hash.
  const collide = [{ ...raw[0], campaignId: 'x1', adId: 'x1' }];
  assert.notEqual(
    customConversionRows(CONN, collide, { level: 'campaign', syncedAt: 'now' })[0].row_hash,
    customConversionRows(CONN, collide, { level: 'ad', syncedAt: 'now' })[0].row_hash,
    'level must be part of the identity, not inferred from the object id',
  );
  assert.equal(campaign[0].ad_id, null, 'a campaign row names no ad');
  assert.equal(ad[0].ad_id, 'a1');
  assert.equal(ad[0].level, 'ad');
});

await test('rows: an unreported event writes no row, and a bad day is skipped', () => {
  const raw = [
    { day: '2026-11-01', accountId: 'act_123', campaignId: 'c1', customConversions: [{ actionType: 'offsite_conversion.custom.1', customConversionId: '1', conversions: 0, conversionValue: 0 }] },
    { day: 'lifetime', accountId: 'act_123', campaignId: 'c1', customConversions: [{ actionType: 'offsite_conversion.custom.1', customConversionId: '1', conversions: 4, conversionValue: 0 }] },
  ];
  assert.deepEqual(customConversionRows(CONN, raw, { level: 'campaign', syncedAt: 'now' }), []);
});

await test('rows: a value-only conversion is kept', () => {
  const raw = [{ day: '2026-11-01', accountId: 'act_123', campaignId: 'c1', customConversions: [{ actionType: 'offsite_conversion.custom.1', customConversionId: '1', conversions: 0, conversionValue: 19.5 }] }];
  const rows = customConversionRows(CONN, raw, { level: 'campaign', syncedAt: 'now' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversion_value, 19.5);
});

// ── 3. Additive: the new write cannot cost the old one ──────────────────────
await test('campaign sync: no new insights field is requested', async () => {
  const { api } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    const insights = f.calls.filter((c) => c.path === 'act_123/insights');
    assert.ok(insights.length, 'insights were requested');
    for (const call of insights) {
      const fields = call.params.get('fields');
      // Only the fields the sync already asked for. Anything new here is a
      // chance for Meta to reject the whole request and take spend with it.
      assert.ok(fields.includes('actions'), 'actions still requested');
      assert.ok(!/custom/i.test(fields), `no custom field may be requested: ${fields}`);
    }
  } finally { f.restore(); }
});

await test('campaign sync: KPI rows survive a custom-conversion table that does not exist', async () => {
  const { api, writes } = fakeSupabase({ failTables: ['meta_custom_conversion_daily', 'meta_custom_conversions'] });
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    const r = await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    const kpis = rowsFor(writes, 'marketing_kpis_daily');
    assert.equal(kpis.length, 1, 'the KPI row is written exactly as before');
    assert.equal(kpis[0].conversions, 6, 'purchases unchanged — custom conversions are not added in');
    assert.equal(kpis[0].spend, 123.45);
    assert.equal(r.custom_conversions.rows, 0);
    assert.ok(/not stored/.test(r.custom_conversions.warning), 'the failure is reported, not thrown');
  } finally { f.restore(); }
});

await test('campaign sync: custom conversions and their names are stored when the tables are there', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [{ id: '987654321', name: 'Black Friday 2026 Sign ups', custom_event_type: 'OTHER', is_archived: false }] }),
  });
  try {
    const r = await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    const conv = rowsFor(writes, 'meta_custom_conversion_daily');
    assert.equal(conv.length, 2);
    assert.equal(conv[0].level, 'campaign');
    assert.equal(conv[0].conversions, 207);
    assert.equal(conv[0].company_entity_id, 'co-1');
    const names = rowsFor(writes, 'meta_custom_conversions');
    assert.equal(names[0].name, 'Black Friday 2026 Sign ups');
    assert.equal(names[0].custom_conversion_id, '987654321');
    assert.equal(r.custom_conversions.names, 1);
  } finally { f.restore(); }
});

await test('names: a refused lookup still stores the numbers', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => new Error('(#200) Requires ads_read permission'),
  });
  try {
    const r = await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    assert.equal(rowsFor(writes, 'meta_custom_conversion_daily').length, 2, 'the numbers are stored without their names');
    assert.equal(rowsFor(writes, 'meta_custom_conversions').length, 0);
    assert.ok(/names not refreshed/.test(r.custom_conversions.warning));
    assert.equal(rowsFor(writes, 'marketing_kpis_daily').length, 1, 'and the KPI row is untouched');
  } finally { f.restore(); }
});

await test('a non-Meta platform writes nothing new and reports nothing', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    '/open_api/v1.3/report/integrated/get/': () => ({ code: 0, data: { list: [] } }),
  });
  try {
    const r = await runConnectionSync(api, {}, { ...CONN, platform: 'tiktok_ads', tiktok_advertiser_id: 'adv1' }, {
      batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2,
    });
    assert.equal(r.custom_conversions, null);
    assert.equal(rowsFor(writes, 'meta_custom_conversion_daily').length, 0);
  } finally { f.restore(); }
});

// ── 4. The ad-level pass ────────────────────────────────────────────────────
await test('ad sync: ad rows and ad-grain custom conversions, without a second name lookup', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [] }),
    // The creative pass POSTs a batch to the Graph root; an empty batch keeps
    // this test about the conversions rather than creative metadata.
    '': () => [],
  });
  try {
    const r = await runMetaAdLevelSync(api, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 1 });
    assert.ok(rowsFor(writes, 'meta_ad_performance_daily').length >= 1, 'ad performance rows still written');
    const conv = rowsFor(writes, 'meta_custom_conversion_daily');
    assert.ok(conv.length >= 1);
    assert.ok(conv.every((c) => c.level === 'ad'));
    assert.equal(r.custom_conversions.names, 0);
    assert.equal(f.calls.filter((c) => c.path === 'act_123/customconversions').length, 0,
      'the campaign pass already refreshed the names this run');
  } finally { f.restore(); }
});

await test('ad sync: ad performance rows survive a failing custom-conversion write', async () => {
  const { api, writes } = fakeSupabase({ failTables: ['meta_custom_conversion_daily'] });
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    '': () => [],
  });
  try {
    const r = await runMetaAdLevelSync(api, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 1 });
    assert.ok(rowsFor(writes, 'meta_ad_performance_daily').length >= 1);
    assert.ok(r.ad_rows_upserted >= 1);
    assert.ok(/not stored/.test(r.custom_conversions.warning));
  } finally { f.restore(); }
});

// ── 5. Reach and frequency ──────────────────────────────────────────────────
await test('reach/frequency: requested, stored, and never summed into anything', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    const fields = f.calls.find((c) => c.path === 'act_123/insights').params.get('fields');
    assert.ok(/(^|,)reach(,|$)/.test(fields) && /(^|,)frequency(,|$)/.test(fields), `reach and frequency requested: ${fields}`);
    const kpi = rowsFor(writes, 'marketing_kpis_daily')[0];
    assert.equal(kpi.reach, 780);
    assert.equal(kpi.frequency, 1.2821);
    assert.equal(kpi.impressions, 1000, 'impressions untouched');
  } finally { f.restore(); }
});

await test('reach/frequency: not reported is null, never zero', async () => {
  const { api, writes } = fakeSupabase();
  const { reach, frequency, ...noReach } = INSIGHT;
  const f = withFetch({
    'act_123/insights': () => ({ data: [noReach] }),
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    const kpi = rowsFor(writes, 'marketing_kpis_daily')[0];
    assert.equal(kpi.reach, null, 'an ad with no reported reach has not reached nobody');
    assert.equal(kpi.frequency, null);
  } finally { f.restore(); }
});

await test('reach/frequency: a field Meta refuses costs the column, not the spend', async () => {
  const { api, writes } = fakeSupabase();
  let refused = 0;
  const f = withFetch({
    'act_123/insights': (params) => {
      const fields = params.get('fields');
      if (/frequency/.test(fields)) {
        refused += 1;
        return new Error('(#100) Tried accessing nonexisting field (frequency) on node type (AdAccount)');
      }
      const { reach, frequency, ...row } = INSIGHT;
      return { data: [row] };
    },
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    const r = await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    assert.ok(refused > 0, 'the first attempt did ask for it');
    const kpi = rowsFor(writes, 'marketing_kpis_daily')[0];
    assert.equal(kpi.spend, 123.45, 'spend still landed');
    assert.equal(kpi.frequency, null);
    assert.ok(r.kpi_rows_upserted >= 1);
  } finally { f.restore(); }
});

await test('reach/frequency: the ad-level pass carries them too', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    '': () => [],
  });
  try {
    await runMetaAdLevelSync(api, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 1 });
    const perf = rowsFor(writes, 'meta_ad_performance_daily')[0];
    assert.equal(perf.reach, 780);
    assert.equal(perf.frequency, 1.2821);
  } finally { f.restore(); }
});

await test('reach/frequency: a database without the columns still stores spend', async () => {
  // How PostgREST answers before the migration is applied: the WHOLE batch is
  // rejected, not just the unknown column.
  const writes = [];
  let rejected = 0;
  const api = {
    from(table) {
      const b = {
        upsert(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          if (rows.some((r) => 'reach' in r || 'frequency' in r)) {
            rejected += 1;
            return Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'reach' column of 'marketing_kpis_daily' in the schema cache" } });
          }
          writes.push({ table, payload: rows });
          return Promise.resolve({ data: null, error: null });
        },
        select() { return b; }, eq() { return b; }, order() { return b; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return b;
    },
  };
  const f = withFetch({
    'act_123/insights': () => ({ data: [INSIGHT] }),
    'act_123/customconversions': () => ({ data: [] }),
  });
  try {
    const r = await runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 });
    assert.ok(rejected > 0, 'the first attempt did carry the new columns');
    const kpi = rowsFor(writes, 'marketing_kpis_daily')[0];
    assert.ok(kpi, 'the KPI row was still written');
    assert.equal(kpi.spend, 123.45);
    assert.ok(!('reach' in kpi) && !('frequency' in kpi), 'written without the columns the database lacks');
    assert.equal(r.kpi_rows_upserted, 1);
  } finally { f.restore(); }
});

await test('a real write failure is still a failure, not swallowed as a missing column', async () => {
  const api = {
    from() {
      const b = {
        upsert() { return Promise.resolve({ data: null, error: { message: 'permission denied for table marketing_kpis_daily' } }); },
        select() { return b; }, eq() { return b; }, order() { return b; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return b;
    },
  };
  const f = withFetch({ 'act_123/insights': () => ({ data: [INSIGHT] }) });
  try {
    await assert.rejects(
      () => runConnectionSync(api, {}, CONN, { batchId: 'b1', now: new Date('2026-11-03T12:00:00Z'), daysBackOverride: 2 }),
      /permission denied/,
    );
  } finally { f.restore(); }
});

// ── 5. The migration and the vendored copy ──────────────────────────────────
await test('the migration is additive: it alters no existing marketing table', () => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations/20261104000500_meta_custom_conversions.sql'), 'utf8');
  for (const forbidden of [
    /alter\s+table\s+(?:public\.)?marketing_kpis_daily/i,
    /alter\s+table\s+(?:public\.)?meta_ad_performance_daily/i,
    /drop\s+table/i,
    /delete\s+from/i,
  ]) {
    assert.ok(!forbidden.test(sql), `migration must not contain ${forbidden}`);
  }
  assert.ok(/security_invoker\s*=\s*true/.test(sql), 'the view is security_invoker');
  assert.ok(/attach_stamp_company_entity_id_triggers/.test(sql), 'company stamp triggers attached');

  // The reach/frequency migration does alter the two marketing tables -- but
  // only by ADDING nullable columns. Anything else there would rewrite rows.
  const rf = readFileSync(join(ROOT, 'supabase/migrations/20261104001000_meta_reach_frequency.sql'), 'utf8');
  for (const forbidden of [
    /drop\s+column/i,
    /alter\s+column/i,
    // Catalog text may be updated; a marketing ROW may not.
    /update\s+public\.(?:marketing_kpis_daily|meta_ad_performance_daily)/i,
    /delete\s+from/i,
  ]) {
    assert.ok(!forbidden.test(rf), `reach/frequency migration must not contain ${forbidden}`);
  }
  // A NOT NULL or a DEFAULT on a new column rewrites or constrains every
  // existing row; these two must stay plain nullable adds.
  for (const stmt of rf.match(/alter table[\s\S]*?;/gi) || []) {
    assert.ok(!/not\s+null/i.test(stmt), `column add must stay nullable: ${stmt}`);
    assert.ok(!/default/i.test(stmt), `column add must carry no default: ${stmt}`);
  }
  assert.ok(/add column if not exists reach/.test(rf) && /add column if not exists frequency/.test(rf));
});

await test('the edge function ships a byte-identical copy of the sync core', () => {
  assert.equal(
    readFileSync(join(ROOT, 'supabase/functions/ad-platform-sync-run/lib/ad-platforms-sync-core.mjs'), 'utf8'),
    readFileSync(CORE, 'utf8'),
    'supabase/functions/ad-platform-sync-run/lib/ad-platforms-sync-core.mjs is a VERBATIM copy (scripts/CLAUDE.md) — re-copy it',
  );
});

console.log(`\n${passed} passed`);
