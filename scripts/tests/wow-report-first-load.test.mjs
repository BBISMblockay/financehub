/* The Marketing Report's first load, as the page actually runs it.
 *
 * Why this file exists. Of the ten RPCs v2/wow-report.html fires, nine degrade
 * to an "unavailable" card. wow_report is thrown, because the window dates,
 * the KPI band and every sales table are built from it -- so it is the page's
 * single point of failure, and it is also the call with the least headroom:
 * measured on production 2026-10-12, 4.6s on a cold cache against 1.9s warm,
 * under the 8s `authenticated` statement_timeout. That is why the failures
 * Blake reported were on the INITIAL load and not on later ones, and why one
 * retry (which runs against the buffers the cancelled attempt warmed) is the
 * difference between a red banner and a report.
 *
 * `load` is lifted out of the shipped page by name and evaluated, so these run
 * against the real source text rather than a copy of the logic -- same
 * approach as wow-report-destination.test.mjs, for the same reason: a fix that
 * passes in isolation while the page calls something else is not a fix.
 *
 * Mutations (each must make this file FAIL):
 *   WOW_FIRST_LOAD_MUTATION=no-retry        (wow_report gets one attempt)
 *   WOW_FIRST_LOAD_MUTATION=no-failed-clear (FAILED survives across loads)
 *   WOW_FIRST_LOAD_MUTATION=retry-everything (the retry re-fires every RPC)
 *   WOW_FIRST_LOAD_MUTATION=silent-retry     (the retry says nothing to the user)
 *
 * Run:  node scripts/tests/wow-report-first-load.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const PAGE = new URL('../../v2/wow-report.html', import.meta.url);
const mutation = process.env.WOW_FIRST_LOAD_MUTATION || '';
assert.ok(['', 'no-retry', 'no-failed-clear', 'retry-everything', 'silent-retry'].includes(mutation),
  `Unknown mutation ${mutation}`);

const pristine = await readFile(PAGE, 'utf8');
let html = pristine;
if (mutation === 'no-retry') {
  html = html.replace(
    `      if (main.error) {
        console.warn('wow_report failed, retrying once:', main.error.message);
        main = await sb.rpc('wow_report', { p_report_date: d, p_grain: gr });
      }`,
    '      // retry removed by mutation');
} else if (mutation === 'no-failed-clear') {
  html = html.replace('      FAILED.clear();\n', '');
} else if (mutation === 'silent-retry') {
  html = html.replace(
    "        setStatus('The report query timed out. Retrying once\\u2026', 'warn');\n", '');
} else if (mutation === 'retry-everything') {
  html = html.replace(
    `        main = await sb.rpc('wow_report', { p_report_date: d, p_grain: gr });`,
    `        [main, kpi] = await Promise.all([
          sb.rpc('wow_report', { p_report_date: d, p_grain: gr }),
          sb.rpc('wow_kpi_compare', { p_report_date: d, p_grain: gr }),
        ]);`);
}
if (mutation) assert.notEqual(html, pristine, `mutation ${mutation} did not apply`);

/** Lift a named async function out of the page by brace matching. */
function lift(name) {
  const start = html.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in wow-report.html`);
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for (; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `could not brace-match ${name}`);
  return html.slice(start, end);
}

const loadSrc = lift('load');

// The report payload only has to satisfy what load() itself reads after the
// RPCs return: DATA.window.end for the completeness notice.
const REPORT = { window: { start: '2026-10-05', end: '2026-10-11' } };

function runLoad({ reportAttempts, seedFailed = [] }) {
  const calls = [];
  const statuses = [];
  const failed = new Set(seedFailed);
  let reportSeen = 0;

  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    // Every RPC but wow_report answers immediately and cleanly. wow_report
    // answers from `reportAttempts`, one entry per attempt.
    sb: {
      async rpc(fn) {
        calls.push(fn);
        if (fn !== 'wow_report') return { data: {}, error: null };
        const outcome = reportAttempts[reportSeen] ?? 'error';
        reportSeen += 1;
        return outcome === 'ok'
          ? { data: REPORT, error: null }
          : { data: null, error: { message: 'canceling statement due to statement timeout' } };
      },
    },
    el: () => ({ value: '2026-10-11' }),
    setStatus: (msg, type) => statuses.push({ msg, type }),
    GRAIN: 'week',
    FAILED: failed,
    DATA: null, KPI: null, FUNNEL: null, PAID: null, REALITY: null,
    LANDING: null, CODES: null, COHORTS: null, ORGANIC: null,
    CREATIVES: null, CRE_SHOWN: null, DATA_THROUGH: null,
    render() {}, buildManual() {}, renderCohorts() {}, initCollapse() {},
    async loadEntry() {},
    window: { __SILO_CONFIG__: { ensureActiveCompany: async () => ({ id: 'co' }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(`${loadSrc}\nvar __p = load({ companyResolved: true });`).runInContext(sandbox);
  return sandbox.__p.then(() => ({
    calls,
    statuses,
    failed,
    reportCalls: calls.filter((c) => c === 'wow_report').length,
    DATA: sandbox.DATA,
    lastStatus: statuses[statuses.length - 1],
  }));
}

// 1. The case Blake hit: wow_report times out on the cold first attempt and
//    succeeds warm. The page must show a report, not a red banner.
{
  const r = await runLoad({ reportAttempts: ['error', 'ok'] });
  assert.equal(r.reportCalls, 2, 'wow_report should be retried exactly once after a failure');
  assert.deepEqual(r.DATA, REPORT, 'the retry result must be the data the page renders');
  assert.notEqual(r.lastStatus.type, 'neg',
    `a recovered load must not end on the red banner (got ${JSON.stringify(r.lastStatus)})`);
  // Worst case is two attempts, so the page must say what it is doing rather
  // than leaving "Loading..." up for both of them.
  assert.ok(r.statuses.some((st) => st.type === 'warn' && /retry/i.test(st.msg)),
    `the retry must be visible in the status line (got ${JSON.stringify(r.statuses)})`);
}

// 2. A first attempt that works is not retried -- the retry must cost nothing
//    on the overwhelming majority of loads.
{
  const r = await runLoad({ reportAttempts: ['ok'] });
  assert.equal(r.reportCalls, 1, 'a successful wow_report must not be re-fired');
  assert.deepEqual(r.DATA, REPORT);
}

// 3. The retry is bounded. Two genuine failures still end in the red banner
//    rather than looping, and the user is told.
{
  const r = await runLoad({ reportAttempts: ['error', 'error'] });
  assert.equal(r.reportCalls, 2, 'wow_report must be attempted twice and no more');
  assert.equal(r.lastStatus.type, 'neg', 'two failures must surface as the error banner');
  assert.match(r.lastStatus.msg, /statement timeout/,
    'the banner should carry the underlying message, which is what names the cause');
}

// 4. The retry is wow_report ONLY. Re-firing the whole batch would double the
//    load on the very tables that just timed out.
{
  const r = await runLoad({ reportAttempts: ['error', 'ok'] });
  const kpi = r.calls.filter((c) => c === 'wow_kpi_compare').length;
  assert.equal(kpi, 1, 'wow_kpi_compare must be fired once, not re-fired with the retry');
  for (const fn of ['wow_funnel', 'wow_cohorts', 'wow_discount_codes']) {
    assert.equal(r.calls.filter((c) => c === fn).length, 1, `${fn} must be fired exactly once`);
  }
}

// 5. FAILED is module-level and nine render paths read it to print
//    "unavailable". Nothing used to reset it, so one transient timeout left a
//    section reading unavailable for the rest of the tab's life -- including
//    after a Refresh that had just fetched the data sitting behind the notice.
{
  const r = await runLoad({ reportAttempts: ['ok'], seedFailed: ['codes', 'cohorts'] });
  assert.equal(r.failed.has('codes'), false,
    'a clean load must clear a stale "codes unavailable" notice');
  assert.equal(r.failed.has('cohorts'), false,
    'a clean load must clear a stale "cohorts unavailable" notice');
}

// 6. Clearing FAILED must not swallow a failure from THIS load.
{
  const calls = [];
  const failed = new Set();
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    sb: {
      async rpc(fn) {
        calls.push(fn);
        if (fn === 'wow_report') return { data: REPORT, error: null };
        if (fn === 'wow_cohorts') return { data: null, error: { message: 'boom' } };
        return { data: {}, error: null };
      },
    },
    el: () => ({ value: '2026-10-11' }),
    setStatus() {},
    GRAIN: 'week',
    FAILED: failed,
    DATA: null, KPI: null, FUNNEL: null, PAID: null, REALITY: null,
    LANDING: null, CODES: null, COHORTS: null, ORGANIC: null,
    CREATIVES: null, CRE_SHOWN: null, DATA_THROUGH: null,
    render() {}, buildManual() {}, renderCohorts() {}, initCollapse() {},
    async loadEntry() {},
    window: { __SILO_CONFIG__: { ensureActiveCompany: async () => ({ id: 'co' }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(`${loadSrc}\nvar __p = load({ companyResolved: true });`).runInContext(sandbox);
  await sandbox.__p;
  assert.equal(failed.has('cohorts'), true,
    'a section that failed on THIS load must still be marked unavailable');
}

// 7. The page really calls this code: boot() hands the first load
//    companyResolved so it does not re-resolve what it just resolved.
assert.match(html, /await load\(\{ companyResolved: true \}\)/,
  'boot() must still drive the first load through load()');

console.log('wow-report-first-load: all checks passed'
  + (mutation ? ` (mutation ${mutation} -- THIS SHOULD HAVE FAILED)` : ''));
if (mutation) {
  console.error(`MUTATION ${mutation} DID NOT FAIL THE SUITE`);
  process.exit(1);
}
