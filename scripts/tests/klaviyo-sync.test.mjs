// klaviyo-sync (scripts/lib/klaviyo-sync-core.mjs): Klaviyo's own API -> SILO.
//
// What this suite pins is the handful of properties that are invisible in a
// diff and expensive to get wrong:
//
//   * nothing is written until every fetch has succeeded, so a failure halfway
//     cannot sweep away rows it never reached;
//   * a sweep touches only rows older than THIS run, and a performance sweep
//     only the window it just asked for -- another window's totals are a
//     different measurement, not a stale one;
//   * a statistic Klaviyo did not report stays NULL, never 0, and a series
//     value is read for its OWN day;
//   * the daily series is asked for in <= 60-day slices, because Klaviyo's
//     daily cap is 60 days and not the year the other reports take, and
//     every slice's days are kept;
//   * no rate is ever stored, and conversion_metric_id is stamped on every row;
//   * a scope, a credential or an uninstalled grant is recorded `skipped`, not
//     failed, and is not retried;
//   * Klaviyo's rate limits are respected by construction (Retry-After, and
//     2-per-minute spacing on the campaign report) rather than discovered;
//   * a company syncing Klaviyo natively makes Windsor skip Klaviyo, so the
//     same sends are never stored twice.
//
// Mutations (CI runs each and requires a failure):
//   KLAVIYO_SYNC_MUTATION=writeearly     rows are written before every fetch has finished
//   KLAVIYO_SYNC_MUTATION=sweepstamp     the sweep ignores this run's timestamp
//   KLAVIYO_SYNC_MUTATION=sweepwindow    the performance sweep ignores the timeframe
//   KLAVIYO_SYNC_MUTATION=nullzero       an unreported statistic is stored as 0
//   KLAVIYO_SYNC_MUTATION=seriesindex    every day of a series takes the first value
//   KLAVIYO_SYNC_MUTATION=emptyday       a day Klaviyo did not cover is written as a row
//   KLAVIYO_SYNC_MUTATION=timeframeend   the window's last day ends at midnight, losing it
//   KLAVIYO_SYNC_MUTATION=conversionstamp  rows are stored without the conversion metric
//   KLAVIYO_SYNC_MUTATION=scopeerror     a 403 fails the run instead of being recorded
//   KLAVIYO_SYNC_MUTATION=retry4xx       a 403 is retried, burning the account's quota
//   KLAVIYO_SYNC_MUTATION=retryafter     a 429 is retried without waiting Retry-After
//   KLAVIYO_SYNC_MUTATION=ratebudget     the campaign report is not spaced to 2/minute
//   KLAVIYO_SYNC_MUTATION=nowleak        request spacing reads the wall clock, not this run's
//   KLAVIYO_SYNC_MUTATION=storeddepth    a stored days_back overrules a requested depth
//   KLAVIYO_SYNC_MUTATION=workflowdepth  the nightly sends a depth nobody asked for
//   KLAVIYO_SYNC_MUTATION=channelfilter  campaigns is asked for with a filter the API rejects
//   KLAVIYO_SYNC_MUTATION=metricspagesize  the metrics read asks for a page size again
//   KLAVIYO_SYNC_MUTATION=metricsonepage   only the first page of metrics is read
//   KLAVIYO_SYNC_MUTATION=badrequestlabel  a 400 is reported as a rejected credential
//   KLAVIYO_SYNC_MUTATION=unreadable     an unreadable report reads as zero rows
//   KLAVIYO_SYNC_MUTATION=reauth         an uninstalled grant is refreshed again anyway
//   KLAVIYO_SYNC_MUTATION=dryrun         a dry run writes rows
//   KLAVIYO_SYNC_MUTATION=chunk          a backfill asks Klaviyo for more than a year at once
//   KLAVIYO_SYNC_MUTATION=serieschunk    the daily series is asked for the whole window at once
//   KLAVIYO_SYNC_MUTATION=seriesdrop      only the last sub-window's days are kept
//   KLAVIYO_SYNC_MUTATION=native         Windsor syncs Klaviyo even where SILO syncs it natively
//   KLAVIYO_SYNC_MUTATION=audiencescope  a 403 on lists fails the run instead of dropping names
//   KLAVIYO_SYNC_MUTATION=audiencehard   any lists failure is swallowed, not just a scope refusal
//   KLAVIYO_SYNC_MUTATION=audiencedrop   a campaign is stored without the audience it was sent to
//   KLAVIYO_SYNC_MUTATION=unappliedtable  a missing klaviyo_audiences table fails the nightly
//   KLAVIYO_SYNC_MUTATION=unappliedcolumn a missing audiences column fails the nightly
//   KLAVIYO_SYNC_MUTATION=unappliedany    every write error is treated as "not applied yet"
//   KLAVIYO_SYNC_MUTATION=currencyfield   the connection test stops reading the account's currency
//   KLAVIYO_SYNC_MUTATION=currencyhardfail the connection test's write fails over the missing currency column
//
// Run: node --test scripts/tests/klaviyo-sync.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const MUT = process.env.KLAVIYO_SYNC_MUTATION || '';
const libUrl = new URL('../lib/klaviyo-sync-core.mjs', import.meta.url);
const windsorUrl = new URL('../lib/windsor-sync-core.mjs', import.meta.url);

async function loadCore() {
  let src = fs.readFileSync(libUrl, 'utf8');
  const sub = (from, to) => {
    assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
    src = src.split(from).join(to);
  };

  // Write before the fetches have all finished.
  if (MUT === 'writeearly') {
    sub("  const campaignPerf = await fetchCampaignValues({",
      "  await upsertChunked(supabase, 'klaviyo_messages', campaignMessageRows({ campaigns: campaignPage.data, included: campaignPage.included, ...stamp }), 'company_entity_id,kind,klaviyo_id');\n  const campaignPerf = await fetchCampaignValues({");
  }
  if (MUT === 'sweepstamp') sub("    .lt('synced_at', syncedAt)\n    .select('id');", "    .select('id');");
  if (MUT === 'sweepwindow') {
    sub("    .eq('timeframe_start', timeframe.start)\n    .eq('timeframe_end', timeframe.end)\n", '');
  }
  if (MUT === 'nullzero') sub('    if (picked === undefined) continue;', '    if (picked === undefined) continue;\n    if (picked === null) { if (STATISTIC_COLUMNS[name]) columns[STATISTIC_COLUMNS[name]] = 0; else metrics[name] = 0; continue; }');
  if (MUT === 'seriesindex') sub('(v) => (Array.isArray(v) ? v[i] : undefined)', '(v) => (Array.isArray(v) ? v[0] : undefined)');
  if (MUT === 'emptyday') sub('      if (!Object.keys(columns).length && !Object.keys(metrics).length) return;', '');
  if (MUT === 'timeframeend') sub("end: `${endDate}T23:59:59+00:00`", "end: `${endDate}T00:00:00+00:00`");
  if (MUT === 'conversionstamp') sub('      conversion_metric_id: conversionMetricId,\n      ...columns,', '      ...columns,');
  if (MUT === 'scopeerror') sub('    if (isScopeError(err)) {', '    if (false) {');
  // The audience read is the ONLY fail-soft fetch in the sync, so both of its
  // edges are mutated: refusing to soften a scope refusal, and softening
  // everything.
  if (MUT === 'audiencescope') sub('    if (!isScopeError(err)) throw err;', '    throw err;');
  if (MUT === 'audiencehard') sub('    if (!isScopeError(err)) throw err;', '    if (false) throw err;');
  if (MUT === 'unappliedtable') sub("    if (!isUnappliedSchema(err, 'klaviyo_audiences')) throw err;", '    throw err;');
  if (MUT === 'unappliedcolumn') sub("    if (!isUnappliedSchema(err, 'audiences')) throw err;", '    throw err;');
  if (MUT === 'unappliedany') sub("    && String(e?.message || '').includes(name);", '    || true;');
  if (MUT === 'audiencedrop') sub('      audiences: (campaignId && audienceForCampaign.get(campaignId)) || null,', '      audiences: null,');
  if (MUT === 'retry4xx') sub('    if (res.status === 429 || res.status === 503) {', '    if (res.status === 429 || res.status === 503 || res.status === 403) {');
  if (MUT === 'retryafter') sub('      const waitMs = retryAfter > 0\n        ? (retryAfter * 1000) + Math.floor(random() * 500)', '      const waitMs = retryAfter > 0\n        ? 0');
  if (MUT === 'ratebudget') sub('    if (since < minGap) await sleep(minGap - since);', '');
  if (MUT === 'nowleak') sub('clock, now: () => now().getTime() };', 'clock };');
  if (MUT === 'channelfilter') {
    sub("  return fetchAllPages({ connection, path: 'campaigns', query, log, ...rest });",
      "  const first = await fetchAllPages({ connection, path: 'campaigns', query, log, ...rest });\n"
      + "  await fetchAllPages({ connection, path: 'campaigns', log, ...rest, query: { ...query, filter: \"equals(messages.channel,'email')\" } });\n"
      + '  return first;');
  }
  if (MUT === 'unreadable') sub("    throw new KlaviyoApiError('Klaviyo report response had neither results nor data', { status: null, code: 'unreadable_report' });", '    return { rows: [], dateTimes: [] };');
  if (MUT === 'reauth') sub("  if (connection.reauth_required_at) {\n    throw new KlaviyoReauthRequired('Klaviyo OAuth grant was rejected earlier; reconnect the account');\n  }", '');
  if (MUT === 'dryrun') sub("  if (dryRun) {\n    log(", "  if (false) {\n    log(");
  // The first sync's requested depth losing to the connection's stored one.
  if (MUT === 'storeddepth') sub('  if (startDate || asked) return requested;', '  if (startDate) return requested;');
  if (MUT === 'chunk') sub('export function chunkWindow({ startDate, endDate }, maxDays = MAX_RANGE_DAYS) {', 'export function chunkWindow({ startDate, endDate }, maxDays = 100000) {');
  // The 60-day daily cap ignored: one request for the whole window, which is
  // what Klaviyo answered with a 400 on production.
  if (MUT === 'serieschunk') sub('chunkWindow({ startDate, endDate }, MAX_SERIES_RANGE_DAYS).reverse()', '[{ startDate, endDate }]');
  // Sliced correctly, then all but the last slice thrown away.
  if (MUT === 'seriesdrop') sub('    rows.push(...part.rows);', '    rows.length = 0;\n    rows.push(...part.rows);');

  const b64 = Buffer.from(src).toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

const handlerUrl = new URL('../../supabase/functions/test-klaviyo-connection/handler.mjs', import.meta.url);

/** The connection-test handler, optionally with one fix broken. */
async function loadHandler() {
  if (!MUT) return import(handlerUrl.href);
  let src = fs.readFileSync(handlerUrl, 'utf8');
  const sub = (from, to) => {
    assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
    src = src.split(from).join(to);
  };
  // A real Klaviyo account answered page[size] on /api/metrics with
  // "'page_size' is not a valid field for the resource 'metric'".
  if (MUT === 'metricspagesize') {
    sub("      query: cursor ? { 'page[cursor]': cursor } : {},",
      "      query: cursor ? { 'page[cursor]': cursor, 'page[size]': 100 } : { 'page[size]': 100 },");
  }
  if (MUT === 'metricsonepage') sub('    const next = res.json?.links?.next;', '    const next = null;');
  // The account's currency: read from Klaviyo, and stored even before the
  // migration that adds its column has been applied.
  if (MUT === 'currencyfield') sub('      currency: first?.attributes?.preferred_currency ?? null,', '      currency: null,');
  if (MUT === 'currencyhardfail') sub("    if (err && 'account_currency' in row &&", '    if (false &&');
  if (MUT === 'badrequestlabel') {
    sub('      : metricsRes.status === 401\n', '      : metricsRes.status === 401 || metricsRes.status === 400\n');
  }
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

async function loadWindsor() {
  // Unmutated, the real module is imported as-is. The Windsor core imports
  // siblings by relative path, so a mutated copy has to live BESIDE it --
  // a data: URL has no base to resolve `../../supabase/...` against.
  if (MUT !== 'native') return import('../lib/windsor-sync-core.mjs');
  const from = '  if (await supersededByNative({ supabase, dsId: account.ds_id, companyId: ctx.companyId })) {';
  let src = fs.readFileSync(windsorUrl, 'utf8');
  assert.ok(src.includes(from), `mutation ${MUT}: pattern missing`);
  src = src.split(from).join('  if (false) {');
  const tmp = new URL(`../lib/.klaviyo-mutation-${process.pid}.mjs`, import.meta.url);
  fs.writeFileSync(tmp, src);
  try {
    return await import(tmp.href);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const CO = '11111111-1111-1111-1111-111111111111';
const CONN = '22222222-2222-2222-2222-222222222222';
const METRIC = 'MetricPlacedOrder';

const connection = {
  id: CONN,
  company_entity_id: CO,
  auth_mode: 'api_key',
  api_key: 'pk_test',
  conversion_metric_id: METRIC,
  account_timezone: 'America/Los_Angeles',
};

/** A fake Klaviyo. `plan` maps a path fragment to a response or a thrower, and
 * every call is recorded so a test can assert on what was asked, in order. */
function fakeKlaviyo(plan, calls = []) {
  return async (url, init = {}) => {
    const u = String(url);
    // The token endpoint is form-encoded, every other call is JSON: record
    // whichever this is rather than assuming one shape.
    let body = null;
    if (init.body) {
      try { body = JSON.parse(init.body); }
      catch (_) { body = Object.fromEntries(new URLSearchParams(String(init.body))); }
    }
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    const key = Object.keys(plan).find((k) => u.includes(k));
    const entry = key ? plan[key] : null;
    if (!entry) throw new Error(`fake Klaviyo has no plan for ${u}`);
    const answer = typeof entry === 'function' ? entry(calls.filter((c) => c.url.includes(key)).length - 1) : entry;
    return {
      ok: (answer.status ?? 200) >= 200 && (answer.status ?? 200) < 300,
      status: answer.status ?? 200,
      headers: { get: (h) => (answer.headers || {})[h] ?? null },
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
}

const campaignsBody = {
  data: [{
    id: 'camp1',
    attributes: { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', definition: { name: 'October drop', archived: false, status: 'sent' } },
    relationships: {
      'campaign-messages': { data: [{ id: 'msg1', type: 'campaign-message' }] },
      // The audience is a RELATED object, not an attribute: without the
      // include there would be an id here and nothing else.
      'campaign-audiences': { data: [{ id: 'aud1', type: 'campaign-audience' }] },
    },
  }],
  included: [{
    id: 'msg1',
    type: 'campaign-message',
    attributes: { definition: { name: 'October drop — email', channel: 'email', status: 'sent', content: { subject: 'New drop' }, send_options: { send_time: '2026-10-05T17:00:00Z' } } },
  }, {
    id: 'aud1',
    type: 'campaign-audience',
    // One included id is a LIST and one is a SEGMENT, mixed in one array, which
    // is what Klaviyo does and why the ids are resolved on id alone.
    attributes: { definition: { name: 'October drop audience', included: ['list1', 'seg1'], excluded: ['seg2'], priority: 1 } },
  }],
  links: { next: null },
};

const listsBody = {
  data: [{ id: 'list1', type: 'list', attributes: { name: 'Newsletter', created: '2025-02-01T00:00:00Z', updated: '2026-02-01T00:00:00Z', opt_in_process: 'single_opt_in' } }],
  links: { next: null },
};

const segmentsBody = {
  data: [
    { id: 'seg1', type: 'segment', attributes: { name: 'Engaged 30 days', created: '2025-03-01T00:00:00Z', updated: '2026-03-01T00:00:00Z', is_active: true } },
    { id: 'seg2', type: 'segment', attributes: { name: 'Unsubscribed', created: '2025-04-01T00:00:00Z', updated: '2026-04-01T00:00:00Z', is_active: true } },
  ],
  links: { next: null },
};

const flowsBody = {
  data: [{ id: 'flow1', attributes: { name: 'Welcome', status: 'live', archived: false, trigger_type: 'Added to List', created: '2025-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' } }],
  links: { next: null },
};

/** Campaign values: one campaign message, with `bounced` deliberately NULL --
 * Klaviyo reporting nothing is a fact, and it must not become 0. */
const campaignValuesBody = {
  data: {
    attributes: {
      results: [{
        groupings: { campaign_id: 'camp1', campaign_message_id: 'msg1', send_channel: 'email' },
        statistics: {
          recipients: 1000, delivered: 980, opens_unique: 400, clicks_unique: 60,
          conversions: 12, conversion_value: 1234.56, bounced: null,
          // Not a column: it must survive in `metrics` rather than vanish.
          open_rate: 0.408,
        },
      }],
    },
  },
};

const flowValuesBody = {
  data: {
    attributes: {
      results: [{
        groupings: { flow_id: 'flow1', flow_message_id: 'fmsg1', send_channel: 'email' },
        statistics: { recipients: 200, delivered: 198, conversions: 4, conversion_value: 99.5 },
      }],
    },
  },
};

/** Two days, and the SECOND day is the one with the deliveries: a reader that
 * takes the first element of every array puts them on the wrong day. The third
 * message row has no statistic for either day and must write no row at all. */
const flowSeriesBody = {
  data: {
    attributes: {
      date_times: ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'],
      results: [
        {
          groupings: { flow_id: 'flow1', flow_message_id: 'fmsg1', send_channel: 'email' },
          statistics: { delivered: [10, 90], conversions: [0, 3], bounced: [null, null] },
        },
        {
          groupings: { flow_id: 'flow1', flow_message_id: 'fmsgQuiet', send_channel: 'sms' },
          statistics: {},
        },
      ],
    },
  },
};

const happyPlan = {
  '/api/campaigns': { body: campaignsBody },
  '/api/flows/': { body: { data: [], included: [], links: { next: null } } },
  '/api/flows?': { body: flowsBody },
  '/api/lists': { body: listsBody },
  '/api/segments': { body: segmentsBody },
  '/api/campaign-values-reports/': { body: campaignValuesBody },
  '/api/flow-values-reports/': { body: flowValuesBody },
  '/api/flow-series-reports/': { body: flowSeriesBody },
};

function planFor(overrides = {}) {
  return { ...happyPlan, ...overrides };
}

function seededDb() {
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({ ...connection });
  return db;
}

const NOW = new Date('2026-11-03T18:00:00Z');

async function runSync(core, {
  db = seededDb(), plan = planFor(), daysBack = 2, startDate = '', endDate = '',
  dryRun = false, conn = connection, clientId = 'cid', clientSecret = 'csec',
  now = () => NOW,
} = {}) {
  const calls = [];
  const sleeps = [];
  const out = await core.syncKlaviyoConnection({
    supabase: db,
    connection: conn,
    daysBack,
    startDate,
    endDate,
    dryRun,
    clientId,
    clientSecret,
    now,
    fetchImpl: fakeKlaviyo(plan, calls),
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  });
  return { out, calls, sleeps, db };
}

// ── windows ────────────────────────────────────────────────────────────────

test('the window ends YESTERDAY in the account timezone, and a whole last day is asked for', async () => {
  const core = await loadCore();
  // 2026-11-03T18:00Z is still 2026-11-03 in Los Angeles, so yesterday is the 2nd.
  const w = core.resolveWindow({ now: NOW, timeZone: 'America/Los_Angeles', daysBack: 3 });
  assert.deepEqual(w, { startDate: '2026-10-31', endDate: '2026-11-02' });
  // Klaviyo rounds a timeframe's end UP to the current hour, so midnight would
  // silently drop the last day.
  const tf = core.reportTimeframe(w);
  assert.equal(tf.start, '2026-10-31T00:00:00+00:00');
  assert.equal(tf.end, '2026-11-02T23:59:59+00:00');
});

test('a backfill is cut into <= 365-day chunks, newest first, disjoint and covering', async () => {
  const core = await loadCore();
  const chunks = core.chunkWindow({ startDate: '2024-01-01', endDate: '2026-11-02' });
  assert.ok(chunks.length >= 3, 'nearly three years must be more than one chunk');
  for (const c of chunks) {
    assert.ok(core.daysBetweenInclusive(c.startDate, c.endDate) <= core.MAX_RANGE_DAYS,
      `chunk ${c.startDate}..${c.endDate} exceeds Klaviyo's one-year reporting limit`);
  }
  assert.equal(chunks[0].endDate, '2026-11-02', 'newest first');
  assert.equal(chunks[chunks.length - 1].startDate, '2024-01-01', 'the whole range is covered');
  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(core.addDays(chunks[i].endDate, 1), chunks[i - 1].startDate, 'chunks must be adjacent and disjoint');
  }
});

// ── the daily series' own 60-day cap ───────────────────────────────────────

/** A flow series whose days follow whatever window was asked for, so a slice
 * that is never requested is a day that is never stored. */
function seriesForRequest(call) {
  const tf = call.body?.data?.attributes?.timeframe || {};
  const start = String(tf.start).slice(0, 10);
  const end = String(tf.end).slice(0, 10);
  return {
    body: {
      data: {
        attributes: {
          date_times: [`${start}T00:00:00Z`, `${end}T00:00:00Z`],
          results: [{
            groupings: { flow_id: 'flow1', flow_message_id: 'fmsg1', send_channel: 'email' },
            statistics: { delivered: [1, 2], conversions: [0, 1] },
          }],
        },
      },
    },
  };
}

test('the daily flow series is sliced to <= 60 days, adjacent and disjoint, covering the window', async () => {
  const core = await loadCore();
  // 155 days: one 365-day reporting chunk, but three daily-series slices.
  const START = '2026-06-01';
  const END = '2026-11-02';
  const calls = [];
  const plan = planFor({
    '/api/flow-series-reports/': (i) => seriesForRequest(calls.filter((c) => c.url.includes('flow-series-reports')) [i]),
  });
  const db = seededDb();
  const out = await core.syncKlaviyoConnection({
    supabase: db,
    connection,
    startDate: START,
    endDate: END,
    clientId: 'cid',
    clientSecret: 'csec',
    now: () => NOW,
    fetchImpl: fakeKlaviyo(plan, calls),
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(out.skipped, undefined, `sync skipped unexpectedly: ${out.skipped}`);

  const series = calls.filter((c) => c.url.includes('flow-series-reports'));
  assert.equal(series.length, 3, 'a 155-day window is three daily slices, not one request');
  assert.equal(out.chunks[0].flow_series_requests, 3,
    'the stored record must say how many slices it took');

  const asked = series.map((c) => {
    const tf = c.body.data.attributes.timeframe;
    assert.equal(c.body.data.attributes.interval, 'daily', 'the series must stay a DAILY series');
    return { startDate: String(tf.start).slice(0, 10), endDate: String(tf.end).slice(0, 10) };
  });
  for (const w of asked) {
    assert.ok(core.daysBetweenInclusive(w.startDate, w.endDate) <= core.MAX_SERIES_RANGE_DAYS,
      `slice ${w.startDate}..${w.endDate} is over Klaviyo's 60-day daily cap and would 400`);
  }
  // Oldest first, adjacent, and the whole window covered: a gap is a silently
  // missing day in klaviyo_flow_daily, which no error would ever report.
  assert.equal(asked[0].startDate, START, 'the oldest slice must start at the window start');
  assert.equal(asked[asked.length - 1].endDate, END, 'the newest slice must end at the window end');
  for (let i = 1; i < asked.length; i += 1) {
    assert.equal(core.addDays(asked[i - 1].endDate, 1), asked[i].startDate,
      'slices must be adjacent and disjoint');
  }

  // Every slice's rows are kept, not just the last one's.
  const days = new Set((db.tables.get('klaviyo_flow_daily') || []).map((r) => r.day_date));
  for (const w of asked) {
    assert.ok(days.has(w.startDate), `the day ${w.startDate} from one slice was dropped`);
    assert.ok(days.has(w.endDate), `the day ${w.endDate} from one slice was dropped`);
  }
});

test('a window inside the daily cap is still exactly one series request', async () => {
  const core = await loadCore();
  const { out, calls } = await runSync(core, { daysBack: 2 });
  assert.equal(out.skipped, undefined);
  assert.equal(calls.filter((c) => c.url.includes('flow-series-reports')).length, 1,
    'the nightly must not pay for slicing it does not need');
  assert.equal(out.chunks[0].flow_series_requests, 1);
});

// ── the happy path, and what it stores ─────────────────────────────────────

test('one window: messages, campaign and flow window totals, and flow days', async () => {
  const core = await loadCore();
  const { out, db } = await runSync(core);
  assert.equal(out.skipped, undefined, `sync skipped unexpectedly: ${out.skipped}`);

  const messages = db.tables.get('klaviyo_messages') || [];
  const campaign = messages.find((m) => m.kind === 'campaign');
  assert.ok(campaign, 'the campaign message was not stored');
  assert.equal(campaign.klaviyo_id, 'msg1');
  assert.equal(campaign.parent_id, 'camp1', 'the message must carry its campaign as the parent');
  assert.equal(campaign.channel, 'email');
  assert.equal(campaign.subject, 'New drop');

  const flowMsg = messages.find((m) => m.kind === 'flow_message' && m.klaviyo_id === 'fmsg1');
  assert.ok(flowMsg, 'the flow message named by the reports was not stored');
  assert.equal(flowMsg.parent_id, 'flow1');
  assert.equal(flowMsg.parent_name, 'Welcome');

  const perf = db.tables.get('klaviyo_message_performance') || [];
  assert.equal(perf.length, 2, 'one campaign row and one flow row');
  const camperf = perf.find((r) => r.kind === 'campaign');
  assert.equal(camperf.delivered, 980);
  assert.equal(camperf.conversion_value, 1234.56);
  assert.equal(camperf.timeframe_end, '2026-11-02T23:59:59+00:00');

  const daily = db.tables.get('klaviyo_flow_daily') || [];
  assert.deepEqual(daily.map((r) => [r.day_date, r.delivered]).sort(),
    [['2026-11-01', 10], ['2026-11-02', 90]]);
});

test('a statistic Klaviyo did not report stays NULL, and a statistic with no column survives in metrics', async () => {
  const core = await loadCore();
  const { db } = await runSync(core);
  const camperf = (db.tables.get('klaviyo_message_performance') || []).find((r) => r.kind === 'campaign');
  // Klaviyo returned null: not reported. Zero would claim no bounces happened.
  assert.equal(camperf.bounced, null, 'an unreported statistic must stay null, never 0');
  assert.equal(camperf.metrics.open_rate, 0.408, 'a statistic with no column must survive in metrics');
  // And a rate must never be promoted to a column.
  assert.equal('open_rate' in camperf, false);
});

test('no rate is ever asked for or stored', async () => {
  const core = await loadCore();
  const rates = core.REPORT_STATISTICS.filter((s) => /_rate$/.test(s));
  assert.deepEqual(rates, [], 'the sync must ask for counts only; a rate is derived after pooling');
  assert.deepEqual(Object.keys(core.STATISTIC_COLUMNS).filter((s) => /_rate$/.test(s)), []);
});

test('every stored row carries the conversion metric it was measured against', async () => {
  const core = await loadCore();
  const { db } = await runSync(core);
  for (const table of ['klaviyo_message_performance', 'klaviyo_flow_daily']) {
    for (const row of db.tables.get(table) || []) {
      assert.equal(row.conversion_metric_id, METRIC,
        `${table} row has no conversion metric; rows measured against different metrics are not comparable`);
    }
  }
});

test('a day Klaviyo did not cover for a message writes no row', async () => {
  const core = await loadCore();
  const { db } = await runSync(core);
  const quiet = (db.tables.get('klaviyo_flow_daily') || []).filter((r) => r.klaviyo_id === 'fmsgQuiet');
  assert.deepEqual(quiet, [], 'a row of nulls would claim Klaviyo covered a day it said nothing about');
});

// ── failure, and what it must NOT do ──────────────────────────────────────

test('a failure halfway through the fetches writes nothing and sweeps nothing', async () => {
  const core = await loadCore();
  const db = seededDb();
  // Seed a row an earlier run wrote. A partial fetch must leave it alone.
  db.from('klaviyo_flow_daily').insert({
    company_entity_id: CO, klaviyo_id: 'fmsg1', channel: 'email', day_date: '2026-11-01',
    delivered: 7, synced_at: '2026-01-01T00:00:00Z',
  });
  const plan = planFor({ '/api/flow-series-reports/': { status: 500, body: { errors: [{ detail: 'boom' }] } } });
  await assert.rejects(() => runSync(core, { db, plan }));

  const daily = db.tables.get('klaviyo_flow_daily') || [];
  assert.equal(daily.length, 1, 'the earlier run\'s row must survive a partial fetch');
  assert.equal(daily[0].delivered, 7, 'and must not have been overwritten');
  assert.equal((db.tables.get('klaviyo_messages') || []).length, 0, 'nothing may be written before every fetch has finished');
  const job = (db.tables.get('sync_jobs') || [])[0];
  assert.equal(job.status, 'error');
});

test('the sweep retires only rows older than this run, and only the window it asked for', async () => {
  const core = await loadCore();
  const db = seededDb();
  // (a) a stale day inside the window: this run did not return it, so it goes.
  db.from('klaviyo_flow_daily').insert({
    company_entity_id: CO, klaviyo_id: 'fmsgGone', channel: 'email', day_date: '2026-11-01',
    delivered: 5, synced_at: '2026-01-01T00:00:00Z',
  });
  // (b) a row written by a NEWER overlapping run: it must survive.
  db.from('klaviyo_flow_daily').insert({
    company_entity_id: CO, klaviyo_id: 'fmsgNewer', channel: 'email', day_date: '2026-11-02',
    delivered: 6, synced_at: '2099-01-01T00:00:00Z',
  });
  // (c) a performance row for ANOTHER window: a different measurement, not a
  // stale one, and the sweep must not touch it.
  db.from('klaviyo_message_performance').insert({
    company_entity_id: CO, kind: 'campaign', klaviyo_id: 'msg1', channel: 'email',
    timeframe_start: '2026-01-01T00:00:00+00:00', timeframe_end: '2026-01-31T23:59:59+00:00',
    delivered: 42, synced_at: '2026-02-01T00:00:00Z',
  });

  await runSync(core, { db });

  const daily = db.tables.get('klaviyo_flow_daily') || [];
  assert.equal(daily.some((r) => r.klaviyo_id === 'fmsgGone'), false, 'a day this run did not return must be retired');
  const newer = daily.find((r) => r.klaviyo_id === 'fmsgNewer');
  assert.ok(newer, 'a newer overlapping run\'s row must never be swept');
  assert.equal(newer.delivered, 6);

  const other = (db.tables.get('klaviyo_message_performance') || [])
    .find((r) => r.timeframe_end === '2026-01-31T23:59:59+00:00');
  assert.ok(other, 'another window\'s totals are a different measurement and must survive');
  assert.equal(other.delivered, 42);
});

test('an unreadable report response fails loudly rather than reading as zero rows', async () => {
  const core = await loadCore();
  const plan = planFor({ '/api/campaign-values-reports/': { body: { data: { attributes: { nothing: true } } } } });
  await assert.rejects(() => runSync(core, { plan }),
    (err) => /neither results nor data/.test(err.message),
    '"no rows" and "a shape this code cannot read" must not look the same');
});

// ── configuration states: skipped, not failed, not retried ────────────────

test('a 403 is recorded as skipped, does not fail the run, and is not retried', async () => {
  const core = await loadCore();
  const db = seededDb();
  const plan = planFor({ '/api/campaigns': { status: 403, body: { errors: [{ detail: 'missing campaigns:read' }] } } });
  const { out, calls } = await runSync(core, { db, plan });
  assert.equal(out.skipped, 'insufficient_scope');
  const job = (db.tables.get('sync_jobs') || [])[0];
  assert.equal(job.status, 'skipped');
  assert.match(job.error, /scope/i);
  assert.equal(calls.filter((c) => c.url.includes('/api/campaigns')).length, 1,
    'a scope error is a state to record, and retrying it only burns the account\'s quota');
});

test('a rejected credential is recorded as skipped, not as an outage', async () => {
  const core = await loadCore();
  const db = seededDb();
  const plan = planFor({ '/api/campaigns': { status: 401, body: { errors: [{ detail: 'The API key specified is invalid' }] } } });
  const { out } = await runSync(core, { db, plan });
  assert.equal(out.skipped, 'bad_credential');
  assert.equal((db.tables.get('sync_jobs') || [])[0].status, 'skipped');
});

test('a connection with no credential, or no conversion metric, is skipped before any job row exists', async () => {
  const core = await loadCore();
  const db = seededDb();
  const noKey = await core.syncKlaviyoConnection({
    supabase: db, connection: { ...connection, api_key: null }, now: () => NOW,
    fetchImpl: async () => { throw new Error('must not reach Klaviyo'); },
  });
  assert.equal(noKey.skipped, 'not_configured');
  const noMetric = await core.syncKlaviyoConnection({
    supabase: db, connection: { ...connection, conversion_metric_id: null }, now: () => NOW,
    fetchImpl: async () => { throw new Error('must not reach Klaviyo'); },
  });
  assert.equal(noMetric.skipped, 'no_conversion_metric');
  assert.equal((db.tables.get('sync_jobs') || []).length, 0,
    'a connection that was never configured has not had a sync attempt');
});

test('an OAuth grant already known to be gone is not refreshed again', async () => {
  const core = await loadCore();
  const db = seededDb();
  const { out, calls } = await runSync(core, {
    db,
    conn: {
      ...connection, auth_mode: 'oauth', api_key: null, access_token: 'at', refresh_token: 'rt',
      token_expires_at: '2020-01-01T00:00:00Z', reauth_required_at: '2026-11-01T00:00:00Z',
    },
    // A plan that WOULD answer, so the test turns on whether the token
    // endpoint was asked at all -- not on what it would have said.
    plan: planFor({ 'oauth/token': { body: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 3600 } } }),
  });
  assert.equal(out.skipped, 'reauth_required');
  assert.equal((db.tables.get('sync_jobs') || [])[0].status, 'skipped');
  assert.equal(calls.filter((c) => c.url.includes('oauth/token')).length, 0,
    'refresh is capped at 10/minute, so a grant already known to be gone must not be asked again');
});

test('invalid_grant on refresh marks the connection for reconnection and stops', async () => {
  const core = await loadCore();
  const db = seededDb();
  const { out } = await runSync(core, {
    db,
    conn: {
      ...connection, auth_mode: 'oauth', api_key: null, access_token: 'at', refresh_token: 'rt',
      token_expires_at: '2020-01-01T00:00:00Z',
    },
    plan: planFor({ 'oauth/token': { status: 400, body: { error: 'invalid_grant' } } }),
  });
  assert.equal(out.skipped, 'reauth_required');
  const row = (db.tables.get('klaviyo_connections') || [])[0];
  assert.ok(row.reauth_required_at, 'the row must say it needs reconnecting, or the nightly keeps asking');
});

test('a refreshed OAuth token is persisted and used, and expires_in is believed over any constant', async () => {
  const core = await loadCore();
  const db = seededDb();
  const { calls } = await runSync(core, {
    db,
    conn: {
      ...connection, auth_mode: 'oauth', api_key: null, access_token: 'old', refresh_token: 'rt',
      token_expires_at: '2020-01-01T00:00:00Z',
    },
    plan: planFor({ 'oauth/token': { body: { access_token: 'fresh', refresh_token: 'rt2', expires_in: 120, scope: 'campaigns:read' } } }),
  });
  const row = (db.tables.get('klaviyo_connections') || [])[0];
  assert.equal(row.access_token, 'fresh');
  assert.equal(row.refresh_token, 'rt2', 'a rotated refresh token must replace the old one');
  assert.equal(row.token_expires_at, new Date(NOW.getTime() + 120_000).toISOString());
  const apiCall = calls.find((c) => c.url.includes('/api/campaigns'));
  assert.equal(apiCall.headers.Authorization, 'Bearer fresh', 'the refreshed token must be the one used');
});

// ── rate limits, by construction ──────────────────────────────────────────

test('a 429 is retried only after Retry-After, never immediately', async () => {
  const core = await loadCore();
  const plan = planFor({
    '/api/campaigns': (n) => (n === 0
      ? { status: 429, headers: { 'Retry-After': '7' }, body: { errors: [{ detail: 'slow down' }] } }
      : { body: campaignsBody }),
  });
  const { sleeps } = await runSync(core, { plan });
  assert.ok(sleeps.some((ms) => ms >= 7000),
    'Klaviyo says an immediate retry always 429s again, so Retry-After must be waited out');
});

test('the campaign report is spaced to its documented 2 per minute across a backfill', async () => {
  const core = await loadCore();
  // Two chunks, so the campaign report is asked for twice in one run.
  const { sleeps } = await runSync(core, { startDate: '2024-06-01', endDate: '2026-11-02' });
  // EXACTLY the documented gap, not "at least": the spacing is measured on the
  // clock this run was given, so with a frozen clock the wait is the whole
  // interval. A sleep of 29_999 would mean klaviyoRequest had fallen back to
  // Date.now() and was spacing by wall time -- which no test could then pin
  // without actually waiting out the seconds.
  assert.ok(sleeps.includes(core.MIN_INTERVAL_MS['campaign-values-reports']),
    'two campaign-values calls in one run must be spaced, or the second is thrown away as a 429');
});

test('the spacing is measured on the clock the run was given, not the wall clock', async () => {
  const core = await loadCore();
  // A clock that has already moved a full minute between calls. The documented
  // gap is therefore ALREADY satisfied and nothing should wait -- which can
  // only be true if klaviyoRequest reads this clock. Reading Date.now()
  // instead would see no time passing and wait the whole interval, and that is
  // the failure this pins: the frozen-clock test above cannot tell a leak from
  // a run that happened to take under a millisecond.
  let t = NOW.getTime();
  const { sleeps } = await runSync(core, {
    startDate: '2024-06-01',
    endDate: '2026-11-02',
    now: () => new Date((t += 60_000)),
  });
  // Not ">= 30_000": a leaked wall clock sleeps the interval MINUS however
  // long the run really took, so 29_999 would slip past that bound -- the
  // same millisecond sensitivity this whole fix is about. With the clock it
  // was given, the gap is already 60s and nothing waits at all.
  assert.deepEqual(sleeps.filter((ms) => ms > 1_000), [],
    'a gap the clock says has already passed must not be waited out again');
});

test('every request carries the pinned revision and the right scheme', async () => {
  const core = await loadCore();
  const { calls } = await runSync(core);
  for (const c of calls) {
    assert.equal(c.headers.revision, core.KLAVIYO_REVISION, `${c.url} did not pin a revision`);
    assert.equal(c.headers.Authorization, 'Klaviyo-API-Key pk_test');
  }
});

test('the campaign report asks ONE question for every campaign, grouped, never one per campaign', async () => {
  const core = await loadCore();
  const { calls } = await runSync(core);
  const reports = calls.filter((c) => c.url.includes('campaign-values-reports'));
  assert.equal(reports.length, 1, 'a per-campaign loop would exhaust the 225-a-day budget');
  assert.deepEqual(reports[0].body.data.attributes.group_by, ['campaign_id', 'campaign_message_id', 'send_channel']);
  assert.equal(reports[0].body.data.attributes.conversion_metric_id, METRIC);
});

test('the flow series asks for a daily interval', async () => {
  const core = await loadCore();
  const { calls } = await runSync(core);
  const series = calls.find((c) => c.url.includes('flow-series-reports'));
  assert.equal(series.body.data.attributes.interval, 'daily');
});

test('the connection test pins the SAME revision as the sync', async () => {
  const core = await loadCore();
  const handler = await loadHandler();
  assert.equal(handler.KLAVIYO_REVISION, core.KLAVIYO_REVISION,
    'testing one Klaviyo revision and syncing another proves nothing about the sync');
  assert.equal(handler.KLAVIYO_API_BASE, core.KLAVIYO_API_BASE);
});

test('every endpoint with a documented steady limit is spaced by it', async () => {
  const core = await loadCore();
  // The ones this sync actually calls. A missing entry is a burst waiting to
  // happen the first time an account is large enough to need several pages.
  for (const key of ['campaign-values-reports', 'flow-values-reports', 'flow-series-reports', 'flows', 'campaigns']) {
    assert.ok(core.MIN_INTERVAL_MS[key] > 0, `${key} has no minimum spacing`);
  }
  assert.ok(core.MIN_INTERVAL_MS['campaign-values-reports'] >= 30_000,
    'the campaign report allows 2 a minute, so successive calls are 30s apart at least');
});

// ── dry run ───────────────────────────────────────────────────────────────

test('a dry run reads everything and writes nothing', async () => {
  const core = await loadCore();
  const db = seededDb();
  const { out } = await runSync(core, { db, dryRun: true });
  assert.equal(out.chunks[0].dry_run, true);
  assert.ok(out.chunks[0].flow_daily_rows_upserted > 0, 'a dry run must still report what it would write');
  for (const table of ['klaviyo_messages', 'klaviyo_message_performance', 'klaviyo_flow_daily']) {
    assert.deepEqual(db.tables.get(table) || [], [], `${table} must be untouched by a dry run`);
  }
});

// ── Klaviyo refusing an unfiltered campaign read ──────────────────────────

test('campaigns is read unfiltered, and a 400 is not answered with a filter Klaviyo rejects too', async () => {
  const core = await loadCore();
  const { calls } = await runSync(core);
  const asked = calls.filter((c) => c.url.includes('/api/campaigns'));
  assert.equal(asked.length, 1, 'one unfiltered read returns every channel');
  // /api/campaigns filters on id, name, archived, builder, created_at and
  // updated_at. messages.channel is NOT among them, so retrying a 400 with
  // one could only produce two more 400s and bury the real message.
  assert.ok(!asked.some((c) => c.url.includes('filter')), 'no filter at all');

  const plan = planFor({
    '/api/campaigns': { status: 400, body: { errors: [{ detail: 'nope' }] } },
  });
  const second = await runSync(core, { plan }).catch((err) => err);
  const tried = (second?.calls || []).filter((c) => c.url.includes('/api/campaigns'));
  assert.ok(!tried.some((c) => c.url.includes('messages.channel')),
    'a 400 must surface, not trigger a filter the API does not accept');
});

// ── the live account's first lesson ───────────────────────────────────────

test('the metrics read sends NO page[size], because /api/metrics rejects it', async () => {
  const handler = await loadHandler();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ data: [], links: {} }), { status: 200 });
  };
  const out = await handler.fetchAllMetrics({ authorization: 'Klaviyo-API-Key pk_x', fetchImpl });
  assert.equal(out.ok, true);
  // A real account answered page[size] with
  //   "'page_size' is not a valid field for the resource 'metric'"
  // and the whole connection test failed on it.
  for (const u of urls) {
    assert.ok(!u.includes('page%5Bsize%5D') && !u.includes('page[size]'),
      `metrics must not ask for a page size: ${u}`);
  }
});

test('every metric is read, not just the first page', async () => {
  const handler = await loadHandler();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    const body = call === 1
      ? {
        data: [{ id: 'm1', attributes: { name: 'Viewed Product' } }],
        links: { next: 'https://a.klaviyo.com/api/metrics/?page%5Bcursor%5D=CUR2' },
      }
      : { data: [{ id: 'm2', attributes: { name: 'Placed Order' } }], links: { next: null } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const out = await handler.fetchAllMetrics({ authorization: 'Klaviyo-API-Key pk_x', fetchImpl });
  assert.deepEqual(out.metrics.map((m) => m.id), ['m1', 'm2']);
  // The conversion metric is chosen from this list, so a truncated list can
  // mean Placed Order is never offered -- on exactly the large accounts that
  // page.
  assert.equal(handler.pickConversionMetric(out.metrics)?.name, 'Placed Order');
});

test('a 400 from Klaviyo is not reported to the admin as a rejected credential', async () => {
  const handler = await loadHandler();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({
    id: CONN, company_entity_id: CO, auth_mode: 'api_key', api_key: 'pk_test',
  });
  const fetchImpl = async () => new Response(
    JSON.stringify({ errors: [{ detail: "'page_size' is not a valid field for the resource 'metric'" }] }),
    { status: 400 },
  );
  const res = await handler.runKlaviyoTest({ supabase: db, companyEntityId: CO, fetchImpl });
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'bad_request');
  assert.ok(!/rejected the credential/i.test(res.body.error),
    'a 400 is SILO asking wrongly; telling the admin their key is bad sends them to replace a good one');
  assert.ok(/page_size/.test(res.body.error), "and Klaviyo's own words must survive");

  // 401 still means what it says.
  const fetch401 = async () => new Response(
    JSON.stringify({ errors: [{ detail: 'invalid key' }] }), { status: 401 },
  );
  const bad = await handler.runKlaviyoTest({ supabase: db, companyEntityId: CO, fetchImpl: fetch401 });
  assert.equal(bad.body.code, 'rejected');
  assert.ok(/rejected the credential/i.test(bad.body.error));
});

test('the page states no verdict of its own about why a test failed', () => {
  const page = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  // Comments stripped: this is about what the page SAYS to an admin, and the
  // line explaining why it must not say it is not a violation of itself.
  const code = page.split('\n').filter((l) => !/^\s*(\/\/|<!--)/.test(l)).join('\n');
  // The handler distinguishes 401 (the key), 403 (the scope) and 400 (SILO's
  // own request). A fixed prefix in the browser overrules all three at once,
  // and the one it used to state -- "refused the credential" -- is the single
  // most expensive thing to say wrongly: it sends an admin to replace a key
  // that works.
  assert.ok(!/refused the credential|rejected the credential/.test(code),
    'the page must not label a failure itself; the handler already worded it');
  assert.match(code, /setStatus\(out\?\.error \|\|/,
    "the handler's own message is what the admin reads");
});

test('the Connect with Klaviyo button is hidden until the deployment says it works', () => {
  const page = fs.readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');
  const btn = page.match(/<button[^>]*id="btn-connect-klaviyo"[^>]*>/);
  assert.ok(btn, 'the button exists');
  assert.ok(/\shidden\b/.test(btn[0]),
    'it must start hidden: OAuth needs a registered Klaviyo app AND the function deployed, '
    + 'and without them the click produced a raw "Failed to fetch"');
  assert.ok(page.includes('probeKlaviyoOauth'), 'something has to decide to show it');
  // Shown ONLY on an explicit yes. Any other answer -- including the function
  // not being deployed, which throws -- leaves it hidden.
  assert.match(page, /configured = res\.ok && out\?\.configured === true;/);
  assert.match(page, /catch \(_\) \{\s*configured = false;/);
  assert.match(page, /btn\.hidden = !configured;/);

  const fn = fs.readFileSync(
    new URL('../../supabase/functions/klaviyo-oauth-start/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /if \(req\.method === 'GET'\) return json\(\{ configured: Boolean\(CLIENT_ID\) \}\);/);
  // The probe must not be able to mint a grant or spend the MFA gate.
  const probeAt = fn.indexOf("req.method === 'GET'");
  assert.ok(probeAt > fn.indexOf('getUser'), 'the probe still requires a signed-in caller');
  assert.ok(probeAt < fn.indexOf('await checkMfaSession('), 'but creates no state and spends no MFA step');
  assert.ok(probeAt > fn.indexOf('checkIntegrationToken(req'), 'and a third-party token is refused first');
});

// ── Windsor must stand down ───────────────────────────────────────────────

test('Windsor skips Klaviyo for a company that syncs it natively, and only for that company', async () => {
  const windsor = await loadWindsor();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({
    id: CONN, company_entity_id: CO, is_active: true, sync_enabled: true,
  });
  assert.equal(await windsor.supersededByNative({ supabase: db, dsId: 'klaviyo', companyId: CO }), true);
  // Another company with no native connection is untouched.
  assert.equal(await windsor.supersededByNative({ supabase: db, dsId: 'klaviyo', companyId: '33333333-3333-3333-3333-333333333333' }), false);
  // A connection that exists but is switched off does not supersede anything.
  const off = createFakeSupabase();
  off.from('klaviyo_connections').insert({ id: CONN, company_entity_id: CO, is_active: true, sync_enabled: false });
  assert.equal(await windsor.supersededByNative({ supabase: off, dsId: 'klaviyo', companyId: CO }), false);
  // And a source with no native connector at all is never checked.
  assert.equal(await windsor.supersededByNative({ supabase: db, dsId: 'tiktok', companyId: CO }), false);
});

test('a Windsor Klaviyo account is not read at all where the company syncs natively', async () => {
  const windsor = await loadWindsor();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({ id: CONN, company_entity_id: CO, is_active: true, sync_enabled: true });
  const summary = await windsor.syncAccount({
    supabase: db,
    fetchImpl: async () => { throw new Error('Windsor must not be asked anything'); },
    key: 'k',
    account: {
      id: 'acc', company_entity_id: CO, ds_id: 'klaviyo', account_id: 'KL1',
      sync_enabled: true, mapping_generation: 1,
    },
    now: NOW,
  });
  assert.equal(summary.status, 'superseded_by_native');
  assert.equal(summary.rows_written, 0);
});

// ── the bootstrap plan ───────────────────────────────────────────────────

test('the first-sync plan is skipped only when BOTH auth modes are absent', async () => {
  const { planBootstrap } = await import('../lib/integration-bootstrap-core.mjs');
  const job = { integration: 'klaviyo', company_entity_id: CO, connection_id: null };
  const withKey = planBootstrap(job, { connection: { api_key: 'pk_x' } });
  assert.equal(withKey[0].skip, null, 'a pasted key is a credential');
  const withOauth = planBootstrap(job, { connection: { access_token: 'at' } });
  assert.equal(withOauth[0].skip, null, 'so is an OAuth token');
  const withNeither = planBootstrap(job, { connection: { display_name: 'Klaviyo' } });
  assert.match(String(withNeither[0].skip), /missing one of/,
    'a connection awaiting a credential is skipped, not retried as a failure');
  assert.equal(withNeither[0].script, 'scripts/klaviyo-sync.mjs');
});

// ── how deep a first sync pulls ───────────────────────────────────────────

test('a requested depth beats the connection\'s stored one', async () => {
  const { effectiveDaysBack } = await loadCore();
  // Integration Bootstrap asks for 365 for a first sync. Before this, the
  // connection's stored 60 won and a year was silently never fetched.
  assert.equal(
    effectiveDaysBack({ requested: '365', connectionDaysBack: 60 }), '365',
    'asking explicitly must not be overruled by a stored default',
  );
});

test('with nothing requested, the connection\'s own days_back wins', async () => {
  const { effectiveDaysBack } = await loadCore();
  assert.equal(effectiveDaysBack({ requested: '', connectionDaysBack: 90 }), 90);
  assert.equal(effectiveDaysBack({ requested: '   ', connectionDaysBack: 90 }), 90,
    'an empty-but-present variable is still nobody asking');
});

test('with neither, the fallback is used', async () => {
  const { effectiveDaysBack } = await loadCore();
  assert.equal(effectiveDaysBack({ requested: '', connectionDaysBack: null }), 60);
  assert.equal(effectiveDaysBack({ requested: '', connectionDaysBack: 0 }), 60,
    'zero is not a depth');
});

test('a dated backfill needs no depth and keeps what was passed', async () => {
  const { effectiveDaysBack } = await loadCore();
  assert.equal(
    effectiveDaysBack({ requested: '', connectionDaysBack: 60, startDate: '2026-01-01' }), '',
    'resolveWindow ignores daysBack when a start date is given',
  );
});

test('the nightly entry point resolves its depth through that function', async () => {
  // A second copy of the precedence in the entry point is how the production
  // bug survived review: the rule has to live in one place, and the script
  // has to be the thing using it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../klaviyo-sync.mjs', import.meta.url), 'utf8');
  assert.match(src, /effectiveDaysBack\(\{/, 'scripts/klaviyo-sync.mjs must call effectiveDaysBack');
  assert.ok(
    !/connection\.days_back \|\|/.test(src),
    'the entry point must not re-implement the precedence it imports',
  );
  assert.match(
    src, /const DAYS_BACK = process\.env\.KLAVIYO_DAYS_BACK \|\| '';/,
    "defaulting the env var to a number here makes the nightly indistinguishable from an explicit request",
  );
});

test('the nightly sends no depth, so a connection\'s own days_back still wins', async () => {
  // The precedence is only as good as what the scheduled caller passes. With
  // `|| '60'` here, every scheduled run looked like an explicit request for 60
  // and a connection configured for 90 would silently have been cut to 60 --
  // the regression this change would otherwise have introduced.
  const { readFileSync } = await import('node:fs');
  let wf = readFileSync(new URL('../../.github/workflows/klaviyo-sync.yml', import.meta.url), 'utf8');
  if (MUT === 'workflowdepth') wf = wf.replace("inputs.days_back || '' }}", "inputs.days_back || '60' }}");
  const line = wf.split('\n').find((l) => l.includes('KLAVIYO_DAYS_BACK:'));
  assert.ok(line, '.github/workflows/klaviyo-sync.yml must still set KLAVIYO_DAYS_BACK');
  assert.match(line, /inputs\.days_back \|\| ''/,
    'a schedule, and a dispatch naming no depth, must send BLANK');
  // And the end-to-end consequence, not just the string: blank in, stored out.
  const { effectiveDaysBack } = await loadCore();
  assert.equal(effectiveDaysBack({ requested: '', connectionDaysBack: 90 }), 90);
  assert.equal(effectiveDaysBack({ requested: '365', connectionDaysBack: 90 }), '365');
});

// ── Lists and segments: the scopes SILO asks for, used ─────────────────────
// SILO's OAuth has always requested lists:read and segments:read. Until this
// was written nothing called either endpoint, which is a permission asked for
// and not used. These tests pin what that use is, and that losing it cannot
// take the rest of the sync down with it.

test('every list and segment is stored with its kind, and no profile count is invented', async () => {
  const core = await loadCore();
  const { db, calls } = await runSync(core);
  const rows = db.rows('klaviyo_audiences');
  assert.equal(rows.length, 3, 'one list and two segments');
  const list = rows.find((r) => r.klaviyo_id === 'list1');
  assert.equal(list.kind, 'list');
  assert.equal(list.name, 'Newsletter');
  assert.equal(list.company_entity_id, CO, 'company scoped');
  assert.equal(list.created_at_remote, '2025-02-01T00:00:00Z');
  // Klaviyo exposes no count on these endpoints. A column of nulls would read
  // as "nobody is on this list", so there must be no such column at all.
  assert.ok(!('profile_count' in list), 'no count is stored, because Klaviyo reports none');
  assert.equal(list.attributes.opt_in_process, 'single_opt_in', 'the rest of the payload is kept whole');
  assert.deepEqual(rows.filter((r) => r.kind === 'segment').map((r) => r.name).sort(),
    ['Engaged 30 days', 'Unsubscribed']);
  // Both endpoints are read, at the page size they actually allow.
  assert.ok(calls.some((c) => c.url.includes('/api/lists')), 'lists read');
  assert.ok(calls.some((c) => c.url.includes('/api/segments')), 'segments read');
  for (const c of calls.filter((x) => /\/api\/(lists|segments)/.test(x.url))) {
    assert.match(c.url, /page%5Bsize%5D=10/, 'lists and segments cap page size at 10, not 100');
  }
});

test("a campaign carries the audience it was sent to, mixed list and segment ids as returned", async () => {
  const core = await loadCore();
  const { db } = await runSync(core);
  const campaign = db.rows('klaviyo_messages').find((r) => r.kind === 'campaign');
  assert.ok(campaign.audiences, 'the campaign names its audience');
  assert.equal(campaign.audiences.name, 'October drop audience');
  // Stored as returned: one list id and one segment id in the same array,
  // which is why nothing may assume an id's kind.
  assert.deepEqual(campaign.audiences.included, ['list1', 'seg1']);
  assert.deepEqual(campaign.audiences.excluded, ['seg2']);
  const flow = db.rows('klaviyo_messages').find((r) => r.kind === 'flow_message');
  if (flow) assert.equal(flow.audiences ?? null, null, 'a flow message has no audience of its own');
  // The include is what makes this one request rather than one per campaign.
  assert.ok(db.rows('klaviyo_messages').length > 0);
});

test('an account that will not share its lists loses the names, not the sync', async () => {
  const core = await loadCore();
  const { db, out } = await runSync(core, {
    plan: planFor({ '/api/lists': { status: 403, body: { errors: [{ detail: 'missing lists:read' }] } } }),
  });
  assert.equal(db.rows('klaviyo_audiences').length, 0, 'no audience names');
  // Everything else still landed: this is the whole point of fail-soft here.
  assert.ok(db.rows('klaviyo_messages').length > 0, 'messages still written');
  assert.ok(db.rows('klaviyo_message_performance').length > 0, 'performance still written');
  assert.notEqual(out.status, 'failed', 'and the run is not an outage');
});

test('a lists failure that is NOT a refusal still stops the run before anything is written', async () => {
  const core = await loadCore();
  await assert.rejects(runSync(core, {
    plan: planFor({ '/api/lists': { status: 500, body: { errors: [{ detail: 'boom' }] } } }),
  }));
});


// ── accounts:read: the account's name, timezone and currency ──────────────
// SILO now asks for accounts:read at sign-in. The connection test reads
// GET /api/accounts and stores what it says; the currency matters most,
// because Klaviyo reports SMS sending cost with no currency of its own.
function accountsFetch({ accounts = { status: 200 } } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/api/metrics')) {
      return new Response(JSON.stringify({ data: [{ type: 'metric', id: 'MPO', attributes: { name: 'Placed Order' } }], links: {} }), { status: 200 });
    }
    if (u.includes('/api/accounts')) {
      if (accounts.status !== 200) {
        return new Response(JSON.stringify({ errors: [{ detail: 'missing accounts:read' }] }), { status: accounts.status });
      }
      return new Response(JSON.stringify({ data: [{ type: 'account', id: 'ACC1', attributes: {
        test_account: false, timezone: 'Europe/Berlin', preferred_currency: 'EUR', locale: 'de-DE', public_api_key: 'Pk1',
        contact_information: { organization_name: 'Some Shop GmbH' } } }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

test("the connection test stores the account's own name, timezone and currency", async () => {
  const handler = await loadHandler();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({ id: CONN, company_entity_id: CO, auth_mode: 'oauth', access_token: 'at', token_expires_at: new Date(Date.now() + 36e5).toISOString() });
  const res = await handler.runKlaviyoTest({ supabase: db, companyEntityId: CO, fetchImpl: accountsFetch() });
  assert.equal(res.body.success, true);
  assert.equal(res.body.account.currency, 'EUR');
  const { data: row } = await db.from('klaviyo_connections').select('*').eq('id', CONN).maybeSingle();
  assert.equal(row.klaviyo_account_name, 'Some Shop GmbH');
  assert.equal(row.account_timezone, 'Europe/Berlin');
  assert.equal(row.account_currency, 'EUR', "Klaviyo's answer, so the SMS cost stops being assumed USD");
  assert.ok(!res.body.notes.some((n) => /accounts:read/.test(n)), 'nothing to warn about once the scope is granted');
});

test('before the currency column exists, the rest of the test result still lands', async () => {
  // Migration 20261110010000 adds account_currency. Until it is applied,
  // PostgREST refuses the whole update over that one column (PGRST204). The
  // test result, the account name and the conversion metric must survive it.
  const handler = await loadHandler();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({ id: CONN, company_entity_id: CO, auth_mode: 'oauth', access_token: 'at', token_expires_at: new Date(Date.now() + 36e5).toISOString() });
  const unapplied = {
    ...db,
    from(table) {
      const real = db.from(table);
      if (table !== 'klaviyo_connections') return real;
      return new Proxy(real, { get(t, k) {
        if (k !== 'update') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
        return (patch) => ('account_currency' in patch
          ? { eq: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'account_currency' column of 'klaviyo_connections' in the schema cache" } }) }
          : t.update(patch));
      } });
    },
  };
  const res = await handler.runKlaviyoTest({ supabase: unapplied, companyEntityId: CO, fetchImpl: accountsFetch() });
  assert.equal(res.body.success, true);
  const { data: row } = await db.from('klaviyo_connections').select('*').eq('id', CONN).maybeSingle();
  assert.equal(row.last_test_success, true, 'the test result is not lost over a column the database does not have yet');
  assert.equal(row.conversion_metric_id, 'MPO', 'nor is the conversion metric, without which no report runs');
  assert.equal(row.klaviyo_account_name, 'Some Shop GmbH');
  assert.equal(row.account_currency, undefined);
});

test('a grant without accounts:read still passes, and says to reconnect', async () => {
  const handler = await loadHandler();
  const db = createFakeSupabase();
  db.from('klaviyo_connections').insert({ id: CONN, company_entity_id: CO, auth_mode: 'oauth', access_token: 'at', token_expires_at: new Date(Date.now() + 36e5).toISOString() });
  const res = await handler.runKlaviyoTest({ supabase: db, companyEntityId: CO, fetchImpl: accountsFetch({ accounts: { status: 403 } }) });
  assert.equal(res.body.success, true, 'reporting still works without the account details');
  assert.equal(res.body.account.currency, null);
  assert.ok(res.body.notes.some((n) => /accounts:read/.test(n) && /Reconnect/.test(n)));
  const { data: row } = await db.from('klaviyo_connections').select('*').eq('id', CONN).maybeSingle();
  assert.ok(row.account_currency == null, 'no currency is invented for an account that did not say');
});


// ── merged, not applied yet ───────────────────────────────────────────────
// The nightly runs from main, so between a merge and the apply of
// 20261110010000 it meets a database with no klaviyo_audiences table and no
// klaviyo_messages.audiences column. PostgREST refuses those writes outright.
// Every number must still land; only the audience goes.
function unappliedDb({ denied = false } = {}) {
  const db = seededDb();
  const real = db.from.bind(db);
  db.from = (table) => {
    const t = real(table);
    const upsert = t.upsert.bind(t);
    t.upsert = (rows, opts) => {
      const list = Array.isArray(rows) ? rows : [rows];
      if (table === 'klaviyo_audiences') {
        // `denied`: the table exists and the write is REFUSED -- a grant gone
        // wrong, not a migration still to apply. That must stay a failure.
        return Promise.resolve({ data: null, error: denied
          ? { code: '42501', message: 'permission denied for table klaviyo_audiences' }
          : { code: 'PGRST205', message: "Could not find the table 'public.klaviyo_audiences' in the schema cache" } });
      }
      if (table === 'klaviyo_messages' && list.some((r) => 'audiences' in r)) {
        return Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'audiences' column of 'klaviyo_messages' in the schema cache" } });
      }
      return upsert(rows, opts);
    };
    return t;
  };
  return db;
}

test('before the audience migration is applied, the nightly still writes every number', async () => {
  const core = await loadCore();
  const { db, out } = await runSync(core, { db: unappliedDb() });
  assert.notEqual(out.status, 'failed', 'an unapplied migration is not an outage');
  const messages = db.rows('klaviyo_messages');
  assert.ok(messages.length > 0, 'messages still written');
  assert.ok(messages.every((r) => !('audiences' in r)), 'without the column the database does not have yet');
  assert.ok(db.rows('klaviyo_message_performance').length > 0, 'performance still written');
});

test('only a missing audience table or column is forgiven: a refused write still fails the run', async () => {
  const core = await loadCore();
  await assert.rejects(
    () => runSync(core, { db: unappliedDb({ denied: true }) }).then(({ out }) => {
      if (out.status === 'failed') throw new Error(out.error || 'failed');
      return out;
    }),
    'permission denied on a table that exists is a real defect, not the audience migration');
});
