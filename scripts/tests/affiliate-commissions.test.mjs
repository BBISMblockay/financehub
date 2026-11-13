// scripts/tests/affiliate-commissions.test.mjs -- the nightly Affiliate Studio
// run (scripts/lib/affiliate-commissions-core.mjs).
//
// Mutations (CI runs each and requires the suite to FAIL):
//   AFFILIATE_COMMISSIONS_MUTATION=noresolve   orders are not matched before accruing
//   AFFILIATE_COMMISSIONS_MUTATION=stopfirst   one failing program stops the others
//   AFFILIATE_COMMISSIONS_MUTATION=nojob       the run records no sync_jobs row
//   AFFILIATE_COMMISSIONS_MUTATION=nosweep     the live-code notices are not swept
//   AFFILIATE_COMMISSIONS_MUTATION=allcompanies  an empty company list resolves every company
//   AFFILIATE_COMMISSIONS_MUTATION=nocompanyfilter  the company filter is dropped
//   AFFILIATE_COMMISSIONS_MUTATION=longchain   the sync's chained run uses the nightly window
//   AFFILIATE_COMMISSIONS_MUTATION=syncfatal   a lagging commissions run fails the sales sync
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
  allcompanies: ['  if (Array.isArray(onlyCompanyIds) && onlyCompanyIds.length === 0) return summary;', ''],
  nocompanyfilter: ['  if (Array.isArray(onlyCompanyIds)) q = q.in(\'company_entity_id\', onlyCompanyIds);', ''],
  longchain: ['export const CHAINED_LOOKBACK_DAYS = 3;', 'export const CHAINED_LOOKBACK_DAYS = 45;'],
};
// Mutations applied to the orchestrator instead of the core.
const syncMuts = {
  syncfatal: ['      console.log(`::warning title=Affiliate commissions lagging::${affiliate.failed}', '      hadError = true; console.log(`::warning title=Affiliate commissions lagging::${affiliate.failed}'],
};
let mod;
// A name must belong to exactly one of the two maps, and an unknown name must
// still stop the run -- but an orchestrator mutation leaves the core alone, so
// it must NOT be looked up in `muts`. Without this split `syncfatal` died here
// on "unknown mutation", which the workflow's wrapper (any nonzero exit, output
// suppressed) would have reported as mutation-tested while the assertion it is
// meant to prove never ran. Review cycle 1, P2.
if (MUT && !muts[MUT] && !syncMuts[MUT]) throw new Error(`unknown mutation ${MUT}`);
if (MUT && muts[MUT] && syncMuts[MUT]) throw new Error(`mutation ${MUT} is registered twice`);
if (MUT && muts[MUT]) {
  const m = muts[MUT];
  const code = await readFile(SRC, 'utf8');
  assert.ok(code.includes(m[0]), `mutation ${MUT}: pattern not found`);
  const p = join(await mkdtemp(join(tmpdir(), 'acc-')), 'core.mjs');
  await writeFile(p, code.split(m[0]).join(m[1]));
  mod = await import(pathToFileURL(p).href);
} else mod = await import(SRC);
const { runCommissions, LOOKBACK_DAYS, CHAINED_LOOKBACK_DAYS } = mod;

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
        in(k, v) { b._f[`in:${k}`] = v; return b; },
        insert: async (row) => { log.push({ insert: t, row }); return { error: null }; },
        then(res) {
          log.push({ select: t, f: b._f });
          const all = [{ id: 'p1', company_entity_id: 'c1' }, { id: 'p2', company_entity_id: 'c2' }];
          const only = b._f['in:company_entity_id'];
          res({ data: only ? all.filter((p) => only.includes(p.company_entity_id)) : all, error: null });
        } };
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


await test('a chained run updates only the companies it was given, over the short window, and says so in the record', async () => {
  const sb = fake();
  const s = await runCommissions({ supabase: sb, now: () => NOW, onlyCompanyIds: ['c2'], lookbackDays: CHAINED_LOOKBACK_DAYS, source: 'shopify_sync' });
  assert.equal(CHAINED_LOOKBACK_DAYS, 3, 'short on purpose: it runs on every sync and shares the 8s timeout');
  assert.ok(CHAINED_LOOKBACK_DAYS < LOOKBACK_DAYS, 'the nightly sweep is the one that reverses late refunds');
  const rpcs = sb.log.filter((x) => x.rpc);
  assert.deepEqual(rpcs.map((x) => `${x.rpc}:${x.args.p_program}`), ['affiliate_resolve_attributions:p2', 'affiliate_accrue_commissions:p2'], 'c1 has a program too and is left alone');
  assert.equal(rpcs[0].args.p_from, '2026-11-07');
  assert.equal(rpcs[0].args.p_to, '2026-11-11');
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.deepEqual(jobs.map((x) => [x.row.company_entity_id, x.row.result.source, x.row.result.from]), [['c2', 'shopify_sync', '2026-11-07']],
    'a 3-day run must not be readable as the 45-day sweep');
  assert.equal(s.programs, 1);
});

await test('no company in the run has a program: nothing is resolved, and nothing is read as "every company"', async () => {
  const sb = fake();
  const s = await runCommissions({ supabase: sb, now: () => NOW, onlyCompanyIds: [], lookbackDays: CHAINED_LOOKBACK_DAYS });
  assert.deepEqual(s, { programs: 0, failed: 0, entries_accrued: 0, entries_reduced: 0, notices: null });
  assert.deepEqual(sb.log, [], 'not even a select');
});

await test('the nightly run still covers every active program over 45 days', async () => {
  const sb = fake();
  await runCommissions({ supabase: sb, now: () => NOW });
  const f = sb.log.find((x) => x.select).f;
  assert.equal(f['in:company_entity_id'], undefined, 'no company filter');
  assert.equal(sb.log.find((x) => x.rpc).args.p_from, '2026-09-26');
});

await test('the Shopify sync resolves the companies it just synced, on the short window, without going red', async () => {
  let js = await readFile(new URL('../shopify-sync.mjs', import.meta.url), 'utf8');
  if (MUT && syncMuts[MUT]) {
    const m = syncMuts[MUT];
    assert.ok(js.includes(m[0]), `mutation ${MUT}: pattern not found`);
    js = js.split(m[0]).join(m[1]);
  }
  assert.match(js, /import \{ runCommissions, CHAINED_LOOKBACK_DAYS \} from '\.\/lib\/affiliate-commissions-core\.mjs'/);
  const block = js.slice(js.indexOf("if (stageEnabled('incremental_sales') || stageEnabled('history_import')) {"));
  const chained = block.slice(0, block.indexOf('if (!SKIP_SUMMARY_REFRESH)'));
  assert.ok(chained.includes('onlyCompanyIds: syncedCompanyIds'), 'only the companies this run synced');
  assert.ok(chained.includes('lookbackDays: CHAINED_LOOKBACK_DAYS'), 'short window');
  assert.ok(chained.includes("source: 'shopify_sync'"));
  assert.ok(!/hadError = true/.test(chained), 'a lagging commissions run is a warning: the sales sync still imported every order');
  assert.ok(/::warning title=Affiliate commissions lagging::/.test(chained), 'and it must be visible, not silent');
  assert.ok(chained.includes('.filter((r) => !r.error && !r.skipped)'), 'a store that failed imported nothing');
});

await test('the index the match depends on ships with the migration and is checked on production', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20261112220000_affiliate_order_match_index.sql', import.meta.url), 'utf8');
  assert.match(sql, /create index if not exists shopify_orders_co_created_coded_idx/);
  // The predicate must match affiliate_resolve_attributions' WHERE clause or
  // the planner cannot use it, and the scan falls back to detoasting every
  // order in the window.
  assert.match(sql, /where discount_codes is not null and jsonb_array_length\(discount_codes\) > 0/);
  const fn = await readFile(new URL('../../supabase/migrations/20261110180000_affiliate_loop.sql', import.meta.url), 'utf8');
  assert.ok(fn.includes('and o.discount_codes is not null\n      and jsonb_array_length(o.discount_codes) > 0'),
    'the function still filters on exactly what the partial index indexes');
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  assert.ok(verify.includes('shopify_orders_co_created_coded_idx'), 'the drift check must notice if it is missing');
  const apply = await readFile(new URL('../../supabase/apply_all_post_merge.sql', import.meta.url), 'utf8');
  assert.ok(apply.includes('20261112220000_affiliate_order_match_index.sql'));
});

console.log(`\naffiliate-commissions: ${passed} passed${MUT ? ` (mutation ${MUT} did not fail)` : ''}`);
