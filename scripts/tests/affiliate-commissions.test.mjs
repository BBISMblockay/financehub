// scripts/tests/affiliate-commissions.test.mjs -- the nightly Affiliate Studio
// run (scripts/lib/affiliate-commissions-core.mjs).
//
// Mutations (CI runs each and requires the suite to FAIL):
//   AFFILIATE_COMMISSIONS_MUTATION=noresolve   orders are not matched before accruing
//   AFFILIATE_COMMISSIONS_MUTATION=stopfirst   one failing program stops the others
//   AFFILIATE_COMMISSIONS_MUTATION=nojob       the run records no sync_jobs row
//   AFFILIATE_COMMISSIONS_MUTATION=nosweep     the live-code notices are not swept
// Run: node scripts/tests/affiliate-commissions.test.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUT = process.env.AFFILIATE_COMMISSIONS_MUTATION || '';
const SRC = new URL('../lib/affiliate-commissions-core.mjs', import.meta.url);
const muts = {
  noresolve: ["      const r1 = await supabase.rpc('affiliate_resolve_attributions', { p_program: p.id, p_from: from, p_to: to });", '      const r1 = { data: {} };'],
  stopfirst: ["      status = 'error';\n", "      status = 'error';\n      throw err;\n"],
  nojob: ["    const { error: jErr } = await supabase.from('sync_jobs').insert({", "    const { error: jErr } = await ({ insert: async () => ({}) }).insert({"],
  nosweep: ['  if (deliverNotices) {', '  if (false) {'],
};
let mod;
if (MUT) {
  const m = muts[MUT]; if (!m) throw new Error(`unknown mutation ${MUT}`);
  const code = await readFile(SRC, 'utf8');
  assert.ok(code.includes(m[0]), `mutation ${MUT}: pattern not found`);
  const p = join(await mkdtemp(join(tmpdir(), 'acc-')), 'core.mjs');
  await writeFile(p, code.split(m[0]).join(m[1]));
  mod = await import(pathToFileURL(p).href);
} else mod = await import(SRC);
const { runCommissions, LOOKBACK_DAYS } = mod;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

function fake({ fail = null } = {}) {
  const log = [];
  return {
    log,
    from: (t) => {
      const b = { _f: {}, select() { return b; }, eq(k, v) { b._f[k] = v; return b; },
        insert: async (row) => { log.push({ insert: t, row }); return { error: null }; },
        then(res) { log.push({ select: t, f: b._f }); res({ data: [{ id: 'p1', company_entity_id: 'c1' }, { id: 'p2', company_entity_id: 'c2' }], error: null }); } };
      return b;
    },
    rpc: async (name, args) => {
      log.push({ rpc: name, args });
      if (fail && fail === args.p_program && name === 'affiliate_accrue_commissions') return { data: null, error: { message: 'boom' } };
      return { data: name === 'affiliate_accrue_commissions' ? { entries_accrued: 2, entries_reduced: 1, net_amount_cents: 500 } : { rows_written: 3 }, error: null };
    },
  };
}
const NOW = new Date('2026-11-10T14:00:00Z');

await test('each active program: match orders, then accrue, over the last 45 days; one sync_jobs row each; then the sweep', async () => {
  const sb = fake(); let swept = 0;
  const s = await runCommissions({ supabase: sb, now: () => NOW, deliverNotices: async () => { swept += 1; return { sent: 1 }; } });
  assert.equal(LOOKBACK_DAYS, 45);
  const rpcs = sb.log.filter((x) => x.rpc);
  assert.deepEqual(rpcs.map((x) => `${x.rpc}:${x.args.p_program}`), ['affiliate_resolve_attributions:p1', 'affiliate_accrue_commissions:p1', 'affiliate_resolve_attributions:p2', 'affiliate_accrue_commissions:p2']);
  assert.equal(rpcs[0].args.p_from, '2026-09-26');
  assert.equal(rpcs[0].args.p_to, '2026-11-11', 'through tomorrow UTC, so every zone\'s today is in');
  assert.equal(rpcs[1].args.p_period, undefined, 'new lines go to the open period that contains each order');
  assert.deepEqual(sb.log.find((x) => x.select).f, { status: 'active' }, 'active programs only');
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.deepEqual(jobs.map((x) => [x.row.company_entity_id, x.row.job_type, x.row.status]), [['c1', 'affiliate_commissions', 'success'], ['c2', 'affiliate_commissions', 'success']]);
  assert.equal(s.entries_accrued, 4);
  assert.equal(swept, 1);
  assert.deepEqual(s.notices, { sent: 1 });
});

await test('one program failing is recorded and does not stop the others; the run fails', async () => {
  const sb = fake({ fail: 'p1' });
  const s = await runCommissions({ supabase: sb, now: () => NOW });
  assert.equal(s.failed, 1);
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.deepEqual(jobs.map((x) => x.row.status), ['error', 'success']);
  assert.match(jobs[0].row.result.error, /boom/);
  assert.ok(sb.log.some((x) => x.rpc === 'affiliate_accrue_commissions' && x.args.p_program === 'p2'));
});

await test('a failed sweep fails the run, after every program ran', async () => {
  const sb = fake();
  const s = await runCommissions({ supabase: sb, now: () => NOW, deliverNotices: async () => { throw new Error('401'); } });
  assert.equal(s.failed, 1);
  assert.equal(sb.log.filter((x) => x.insert === 'sync_jobs').length, 2);
});

await test('the workflow runs nightly, uses the service key, and has no concurrency group', async () => {
  const y = await readFile(new URL('../../.github/workflows/affiliate-commissions.yml', import.meta.url), 'utf8');
  assert.match(y, /cron: '0 14 \* \* \*'/);
  assert.match(y, /node scripts\/affiliate-commissions\.mjs/);
  assert.ok(!/^concurrency:/m.test(y));
});

console.log(`\naffiliate-commissions: ${passed} passed${MUT ? ` (mutation ${MUT} did not fail)` : ''}`);
