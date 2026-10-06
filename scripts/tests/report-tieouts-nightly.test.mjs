/* Nightly tie-outs (scripts/lib/report-tieouts-nightly.mjs). No network.
 *
 * The rules that matter: a check whose pinned report has changed is STALE
 * and fails, never NO DATA; a blank side against a real number is a
 * MISMATCH; each company runs as its own admin and a run that lands on a
 * different company is refused; a company nobody can run as is reported,
 * not silently skipped; and only a bare uuid ever reaches the SQL.
 * Run: node scripts/tests/report-tieouts-nightly.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classify, pickRunners, impersonatedRunSql, runNightly, summaryMarkdown,
  CATALOG_SQL, RUNNERS_SQL, FAILING,
} from '../lib/report-tieouts-nightly.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const U2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const U3 = 'aaaaaaaa-0000-4000-8000-000000000003';

await test('a stale pin is STALE whatever the runner said', () => {
  assert.equal(classify({ verdict: 'NO DATA', left_value: null, right_value: '517495' }, { stale: true, tolerance: '0' }), 'STALE');
  assert.equal(classify({ verdict: 'OK', left_value: '5', right_value: '5' }, { stale: true, tolerance: '0' }), 'STALE');
});

await test('a blank side against a real number is a MISMATCH, not NO DATA', () => {
  assert.equal(classify({ verdict: 'NO DATA', left_value: null, right_value: '517495' }, { stale: false, tolerance: '0' }), 'MISMATCH');
  assert.equal(classify({ verdict: 'NO DATA', left_value: '12', right_value: null }, { stale: false, tolerance: '0' }), 'MISMATCH');
});

await test('both sides blank is NO DATA; a blank against zero is OK', () => {
  assert.equal(classify({ verdict: 'NO DATA', left_value: null, right_value: null }, { stale: false }), 'NO DATA');
  assert.equal(classify({ verdict: 'NO DATA', left_value: null, right_value: '0' }, { stale: false, tolerance: '0' }), 'OK');
});

await test('tolerance is honoured, and an ERROR stays an error', () => {
  assert.equal(classify({ verdict: 'MISMATCH', left_value: '100.004', right_value: '100' }, { tolerance: '0.01' }), 'OK');
  assert.equal(classify({ verdict: 'OK', left_value: '100.02', right_value: '100' }, { tolerance: '0.01' }), 'MISMATCH');
  assert.equal(classify({ verdict: 'ERROR: relation does not exist' }, { tolerance: '0' }), 'ERROR');
  assert.ok(FAILING.has('STALE') && FAILING.has('MISMATCH') && FAILING.has('ERROR') && !FAILING.has('NO DATA'));
});

await test('one runner per company: owner-admin first, then lowest id; nobody = null', () => {
  const runners = pickRunners([
    { company_id: A, title: 'Acme', user_id: U2, membership_role: 'admin' },
    { company_id: A, title: 'Acme', user_id: U3, membership_role: 'owner_admin' },
    { company_id: A, title: 'Acme', user_id: U1, membership_role: 'admin' },
    { company_id: B, title: 'Empty', user_id: null, membership_role: 'admin' },
  ]);
  assert.deepEqual(runners, [
    { company_id: A, title: 'Acme', user_id: U3 },
    { company_id: B, title: 'Empty', user_id: null },
  ]);
});

await test('only a bare uuid can reach the impersonation SQL, and it always rolls back', () => {
  const sql = impersonatedRunSql(U1);
  assert.match(sql, /^begin;\nset local role authenticated;/);
  assert.match(sql, new RegExp(`"sub":"${U1}"`));
  assert.match(sql, /rollback;$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  for (const bad of [`${U1}'; drop table x; --`, 'not-a-uuid', '', null]) {
    assert.throws(() => impersonatedRunSql(bad), /non-uuid/);
  }
});

await test('the catalog compares each pin to the live report, and lists only enabled checks', () => {
  assert.match(CATALOG_SQL, /md5\(r\.queries_run::text \|\| r\.parameters::text\)/);
  assert.match(CATALOG_SQL, /where o\.enabled/);
  assert.match(RUNNERS_SQL, /p\.is_active and p\.active_company_id = e\.id/);
  // The regex inside the SQL matches both pin spellings found in production.
  const pattern = CATALOG_SQL.match(/regexp_matches\(o\.check_sql,\s*'([\s\S]*?)', 'g'\)/)[1].replace(/''/g, "'");
  const re = new RegExp(pattern.replace(/\(\?:/g, '(?:'), 'g');
  for (const sample of [
    "(select md5(queries_run::text || parameters::text) = '5e20d3c117dac2831fa9eda74c541c89' from public.silo_chat_saved_reports where id = 'c1000000-0000-4000-a000-000000000001')",
    "(select md5(queries_run::text || parameters::text) = 'ae90f8822c13a3c836ee641f2617375f' from public.silo_chat_saved_reports where id='c3000000-0000-4000-a000-000000000004')",
  ]) {
    re.lastIndex = 0;
    const m = re.exec(sample);
    assert.ok(m && /^[0-9a-f]{32}$/.test(m[1]) && /^[0-9a-f-]{36}$/.test(m[2]), sample);
  }
});

function fakeQuery({ catalog, runners, runs }) {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql === CATALOG_SQL) return { rows: catalog };
    if (sql === RUNNERS_SQL) return { rows: runners };
    const uid = (sql.match(/"sub":"([0-9a-f-]{36})"/) || [])[1];
    return runs[uid] || { rows: [] };
  };
  return { query, calls };
}

await test('the whole run: stale and mismatch fail, NO DATA does not, nobody-to-run-as is reported', async () => {
  const { query, calls } = fakeQuery({
    catalog: [
      { report_title: 'Inventory Summary', check_name: 'On-hand', tolerance: '0', pins: 1, stale: true },
      { report_title: 'Daily Sales', check_name: 'Canonical', tolerance: '0.01', pins: 1, stale: false },
      { report_title: 'Open POs', check_name: 'Count', tolerance: '0', pins: 0, stale: false },
    ],
    runners: [
      { company_id: A, title: 'Acme', user_id: U1, membership_role: 'owner_admin' },
      { company_id: B, title: 'Nobody', user_id: null, membership_role: null },
    ],
    runs: {
      [U1]: { rows: [
        { company_id: A, report_title: 'Inventory Summary', check_name: 'On-hand', left_value: null, right_value: '517495', verdict: 'NO DATA' },
        { company_id: A, report_title: 'Daily Sales', check_name: 'Canonical', left_value: '100', right_value: '100', verdict: 'OK' },
        { company_id: A, report_title: 'Open POs', check_name: 'Count', left_value: null, right_value: null, verdict: 'NO DATA' },
      ] },
    },
  });
  const out = await runNightly({ query });
  assert.equal(out.failures, 1);
  assert.equal(out.catalogStale, 1);
  const acme = out.companies.find((c) => c.company_id === A);
  assert.deepEqual(acme.counts, { STALE: 1, OK: 1, 'NO DATA': 1 });
  assert.equal(acme.status, 'failing');
  const nobody = out.companies.find((c) => c.company_id === B);
  assert.equal(nobody.status, 'not checked');
  assert.equal(calls.filter((s) => s.startsWith('begin;')).length, 1, 'only companies with a runner are impersonated');
  const md = summaryMarkdown(out);
  assert.match(md, /\| Acme \| STALE \| Inventory Summary \| On-hand \| blank \| 517495 \|/);
  assert.match(md, /\| Nobody \| not checked/);
});

await test('a run that lands on a different company is refused and fails', async () => {
  const { query } = fakeQuery({
    catalog: [{ report_title: 'Daily Sales', check_name: 'Canonical', tolerance: '0', pins: 1, stale: false }],
    runners: [{ company_id: A, title: 'Acme', user_id: U1, membership_role: 'owner_admin' }],
    runs: { [U1]: { rows: [{ company_id: B, report_title: 'Daily Sales', check_name: 'Canonical', left_value: '1', right_value: '1', verdict: 'OK' }] } },
  });
  const out = await runNightly({ query });
  assert.equal(out.failures, 1);
  assert.equal(out.companies[0].status, 'error');
  assert.match(out.companies[0].reason, /expected/);
});

await test('a company whose run errors fails the night; a catalog error stops it', async () => {
  const { query } = fakeQuery({
    catalog: [{ report_title: 'Daily Sales', check_name: 'Canonical', tolerance: '0', pins: 1, stale: false }],
    runners: [{ company_id: A, title: 'Acme', user_id: U1, membership_role: 'admin' }],
    runs: { [U1]: { error: 'HTTP 500: boom' } },
  });
  const out = await runNightly({ query });
  assert.equal(out.failures, 1);
  await assert.rejects(runNightly({ query: async () => ({ error: 'HTTP 401' }) }), /catalog/);
});

const CATALOG2 = [
  { report_title: 'Daily Sales', check_name: 'Canonical', tolerance: '0', pins: 1, stale: false },
  { report_title: 'Open POs', check_name: 'Count', tolerance: '0', pins: 0, stale: false },
];
const ok = (title, name) => ({ company_id: A, report_title: title, check_name: name, left_value: '1', right_value: '1', verdict: 'OK' });
const one = (rows) => fakeQuery({
  catalog: CATALOG2,
  runners: [{ company_id: A, title: 'Acme', user_id: U1, membership_role: 'owner_admin' }],
  runs: { [U1]: { rows } },
});

await test('coverage: a run that returns NO rows fails, every check MISSING', async () => {
  const out = await runNightly({ query: one([]).query });
  assert.equal(out.failures, 2);
  assert.equal(out.companies[0].status, 'failing');
  assert.deepEqual(out.companies[0].counts, { MISSING: 2 });
  assert.match(summaryMarkdown(out), /\| Acme \| MISSING \| Open POs \| Count \|/);
});

await test('coverage: a partial result set fails on the check it left out', async () => {
  const out = await runNightly({ query: one([ok('Daily Sales', 'Canonical')]).query });
  assert.equal(out.failures, 1);
  assert.deepEqual(out.companies[0].counts, { OK: 1, MISSING: 1 });
});

await test('coverage: a duplicated or uncatalogued row is UNEXPECTED and fails', async () => {
  const dup = await runNightly({ query: one([ok('Daily Sales', 'Canonical'), ok('Daily Sales', 'Canonical'), ok('Open POs', 'Count')]).query });
  assert.equal(dup.failures, 1);
  assert.equal(dup.companies[0].counts.UNEXPECTED, 1);
  const extra = await runNightly({ query: one([ok('Daily Sales', 'Canonical'), ok('Open POs', 'Count'), ok('Ghost', 'Not in catalog')]).query });
  assert.equal(extra.failures, 1);
  assert.equal(extra.companies[0].counts.UNEXPECTED, 1);
});

await test('coverage: a complete run passes', async () => {
  const out = await runNightly({ query: one([ok('Daily Sales', 'Canonical'), ok('Open POs', 'Count')]).query });
  assert.equal(out.failures, 0);
  assert.equal(out.companies[0].status, 'ok');
});

await test('an empty catalog stops the run instead of certifying nothing', async () => {
  const { query } = fakeQuery({ catalog: [], runners: [], runs: {} });
  await assert.rejects(runNightly({ query }), /catalog is empty/);
});

await test('the workflow runs the script nightly with the Management API token, read-only', () => {
  const wf = readFileSync(new URL('../../.github/workflows/report-tieouts-nightly.yml', import.meta.url), 'utf8');
  assert.match(wf, /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
  assert.match(wf, /run: node scripts\/report-tieouts-nightly\.mjs/);
  assert.match(wf, /permissions:\s*\n\s*contents: read/);
});

console.log(`\nreport-tieouts-nightly: ${passed} passed`);
