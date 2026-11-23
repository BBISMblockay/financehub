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
//   AFFILIATE_COMMISSIONS_MUTATION=norefresh   old or retired-code credited orders are never re-read for refunds
//   AFFILIATE_COMMISSIONS_MUTATION=refreshsilent a failed re-read leaves the run green
//   AFFILIATE_COMMISSIONS_MUTATION=noseed      product seeding is never swept
//   AFFILIATE_COMMISSIONS_MUTATION=seedsilent  a failed seeding sweep leaves the run green
//   AFFILIATE_COMMISSIONS_MUTATION=nomatch     prospects are never badged as past customers
//   AFFILIATE_COMMISSIONS_MUTATION=matchfatal  a failed past-customer match fails the commissions run
//   AFFILIATE_COMMISSIONS_MUTATION=matchchained the badge runs on every chained sync, not nightly only
//   AFFILIATE_COMMISSIONS_MUTATION=matchrebuild  the customer lookup is rebuilt once per program, not once per company
//   AFFILIATE_COMMISSIONS_MUTATION=nosplit       a window that times out is never halved and retried
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
  norefresh: ["      if (source === 'nightly') {\n        const rr", "      if (false) {\n        const rr"],
  refreshsilent: ["          if (!missing) throw new Error(`refresh credited: ${rr.error.message}`);", "          if (!missing) result.refresh_error = rr.error.message;"],
  noseed: ["      const r3 = await supabase.rpc('affiliate_seed_sweep', { p_program: p.id });", '      const r3 = { data: null };'],
  seedsilent: ["        if (!missing) { status = 'error'; summary.failed += 1; result.seeding_error = r3.error.message; }", '        if (!missing) { result.seeding_error = r3.error.message; }'],
  nomatch: ['          result.customer_match = await refreshAndMatchCustomers({ supabase, program: p, now });', '          result.customer_match = null;'],
  matchfatal: ['        } catch (err) {\n          result.customer_match = { error: String(err?.message || err) };', '        } catch (err) {\n          status = \'error\'; summary.failed += 1;\n          result.customer_match = { error: String(err?.message || err) };'],
  matchchained: ["      if (source === 'nightly') {\n        try {\n          result.customer_match", '      if (true) {\n        try {\n          result.customer_match'],
  matchrebuild: ['            refreshLookup: !lookupDone.has(p.company_entity_id),', '            refreshLookup: true,'],
  nosplit: ['    if (depth >= CUSTOMER_WINDOW_SPLITS || span <= 86400000) throw new Error(`customer lookup: ${r.error.message}`);', '    throw new Error(`customer lookup: ${r.error.message}`);'],
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
const { runCommissions, LOOKBACK_DAYS, CHAINED_LOOKBACK_DAYS, CUSTOMER_WINDOW_DAYS } = mod;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

function fake({ fail = null, seedFail = null, refreshFail = null, matchFail = null, programs = null, slowWindow = null } = {}) {
  const log = [];
  return {
    log,
    from: (t) => {
      const b = { _f: {}, select() { return b; }, eq(k, v) { b._f[k] = v; return b; },
        in(k, v) { b._f[`in:${k}`] = v; return b; },
        not() { return b; }, order() { return b; }, limit() { return b; },
        // The past-customer badge reads the lookup's coverage and the company's
        // oldest order before it walks a backfill window.
        maybeSingle: async () => {
          log.push({ select: t, f: b._f, single: true });
          if (t === 'company_customer_profile_state') return { data: { covered_from: '2026-11-01T00:00:00Z' }, error: null };
          if (t === 'shopify_orders') return { data: { shopify_created_at: '2026-10-01T00:00:00Z' }, error: null };
          return { data: null, error: null };
        },
        insert: async (row) => { log.push({ insert: t, row }); return { error: null }; },
        then(res) {
          log.push({ select: t, f: b._f });
          const all = programs || [{ id: 'p1', company_entity_id: 'c1' }, { id: 'p2', company_entity_id: 'c2' }];
          const only = b._f['in:company_entity_id'];
          res({ data: only ? all.filter((p) => only.includes(p.company_entity_id)) : all, error: null });
        } };
      return b;
    },
    rpc: async (name, args) => {
      log.push({ rpc: name, args });
      if (fail && fail === args.p_program && name === 'affiliate_accrue_commissions') return { data: null, error: { message: 'boom' } };
      if (seedFail === 'missing' && name === 'affiliate_seed_sweep') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.affiliate_seed_sweep(p_program) in the schema cache' } };
      if (seedFail === 'boom' && name === 'affiliate_seed_sweep') return { data: null, error: { code: 'P0001', message: 'seed boom' } };
      if (name === 'affiliate_seed_sweep') return { data: { purchased: 0, earned: 1, expired: 0 }, error: null };
      if (refreshFail === 'missing' && name === 'affiliate_refresh_credited_orders') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.affiliate_refresh_credited_orders(p_program) in the schema cache' } };
      if (refreshFail === 'boom' && name === 'affiliate_refresh_credited_orders') return { data: null, error: { code: 'P0001', message: 'refresh boom' } };
      if (name === 'affiliate_refresh_credited_orders') return { data: { orders_changed: 1, entries_reduced: 1, net_amount_cents: -300 }, error: null };
      // A statement timeout on the first (widest) window, the realistic way a
      // busy store's week fails. Halves succeed.
      if (slowWindow && name === 'refresh_company_customer_profiles') {
        const span = (args.p_until ? Date.parse(args.p_until) : NOW.getTime()) - Date.parse(args.p_since);
        if (span > slowWindow) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      if (matchFail === 'missing' && /customer/.test(name)) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
      if (matchFail === 'boom' && /customer/.test(name)) return { data: null, error: { code: 'P0001', message: 'match boom' } };
      if (name === 'refresh_company_customer_profiles') return { data: { customers_written: 4, customers_total: 40 }, error: null };
      if (name === 'affiliate_match_prospect_customers') return { data: { prospects_checked: 7, likely: 1, possible: 2 }, error: null };
      return { data: name === 'affiliate_accrue_commissions' ? { entries_accrued: 2, entries_reduced: 1, net_amount_cents: 500 } : { rows_written: 3 }, error: null };
    },
  };
}
const NOW = new Date('2026-11-10T14:00:00Z');

await test('each active program: match orders, then accrue, over the last 45 days; one sync_jobs row each; then the sweep', async () => {
  const sb = fake(); let swept = 0;
  const s = await runCommissions({ supabase: sb, now: () => NOW, deliverNotices: async () => { swept += 1; return { sent: 1 }; } });
  assert.equal(LOOKBACK_DAYS, 45);
  // The past-customer badge is asserted on its own below; the money steps are
  // what this order is about.
  const rpcs = sb.log.filter((x) => x.rpc && !/customer/.test(x.rpc));
  assert.deepEqual(rpcs.map((x) => `${x.rpc}:${x.args.p_program}`), ['affiliate_resolve_attributions:p1', 'affiliate_accrue_commissions:p1', 'affiliate_refresh_credited_orders:p1', 'affiliate_seed_sweep:p1', 'affiliate_resolve_attributions:p2', 'affiliate_accrue_commissions:p2', 'affiliate_refresh_credited_orders:p2', 'affiliate_seed_sweep:p2'], 'credited orders of any age are re-read, then seeding is swept, after each program accrues');
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

await test('product seeding: recorded on the run; missing before the migration is not a failure; a real error is', async () => {
  let sb = fake();
  await runCommissions({ supabase: sb, now: () => NOW });
  assert.deepEqual(sb.log.filter((x) => x.insert === 'sync_jobs')[0].row.result.seeding, { purchased: 0, earned: 1, expired: 0 });
  sb = fake({ seedFail: 'missing' });
  let s = await runCommissions({ supabase: sb, now: () => NOW });
  assert.equal(s.failed, 0, 'not applied yet is not a failure');
  assert.deepEqual(sb.log.filter((x) => x.insert === 'sync_jobs').map((x) => x.row.status), ['success', 'success']);
  sb = fake({ seedFail: 'boom' });
  s = await runCommissions({ supabase: sb, now: () => NOW });
  assert.equal(s.failed, 2);
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.deepEqual(jobs.map((x) => x.row.status), ['error', 'error']);
  assert.match(jobs[0].row.result.seeding_error, /seed boom/);
  assert.equal(jobs[0].row.result.entries_accrued, 2, 'the commissions it accrued are still recorded');
});

await test('credited orders of any age: re-read nightly only, recorded on the run; missing is not a failure; a real error is', async () => {
  let sb = fake();
  let s = await runCommissions({ supabase: sb, now: () => NOW });
  const job = sb.log.filter((x) => x.insert === 'sync_jobs')[0].row;
  assert.deepEqual(job.result.credited_refresh, { orders_changed: 1, entries_reduced: 1, net_amount_cents: -300 });
  assert.equal(s.entries_reduced, 4, 'its reductions count with the window\'s');
  sb = fake();
  await runCommissions({ supabase: sb, now: () => NOW, onlyCompanyIds: ['c2'], lookbackDays: CHAINED_LOOKBACK_DAYS, source: 'shopify_sync' });
  assert.ok(!sb.log.some((x) => x.rpc === 'affiliate_refresh_credited_orders'), 'a chained sync run stays short');
  sb = fake({ refreshFail: 'missing' });
  s = await runCommissions({ supabase: sb, now: () => NOW });
  assert.equal(s.failed, 0, 'not applied yet is not a failure');
  sb = fake({ refreshFail: 'boom' });
  s = await runCommissions({ supabase: sb, now: () => NOW });
  assert.equal(s.failed, 2);
  assert.match(sb.log.filter((x) => x.insert === 'sync_jobs')[0].row.result.error, /refresh boom/);
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
  // The past-customer badge is asserted on its own below; the money steps are
  // what this order is about.
  const rpcs = sb.log.filter((x) => x.rpc && !/customer/.test(x.rpc));
  assert.deepEqual(rpcs.map((x) => `${x.rpc}:${x.args.p_program}`), ['affiliate_resolve_attributions:p2', 'affiliate_accrue_commissions:p2', 'affiliate_seed_sweep:p2'], 'c1 has a program too and is left alone');
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

await test('the past-customer badge: the lookup is topped up, older windows walked, then this program\'s prospects badged', async () => {
  const sb = fake();
  const s = await runCommissions({ supabase: sb, now: () => NOW });
  const mine = sb.log.filter((x) => x.rpc && /customer/.test(x.rpc));
  // One recent window, then backfill windows, then the match -- per program.
  assert.equal(mine.filter((x) => x.rpc === 'refresh_company_customer_profiles').length >= 2, true,
    'the recent window and at least one older one');
  const first = mine[0];
  assert.equal(first.rpc, 'refresh_company_customer_profiles');
  assert.equal(first.args.p_since, new Date(NOW.getTime() - CUSTOMER_WINDOW_DAYS * 86400000).toISOString(),
    'the nightly top-up is a short window, because every caller shares the 8s statement timeout');
  assert.ok(CUSTOMER_WINDOW_DAYS <= 3, 'and measured short: a week of a big store\'s orders touches ~11,900 customers');
  const matches = mine.filter((x) => x.rpc === 'affiliate_match_prospect_customers');
  assert.deepEqual(matches.map((x) => x.args.p_program), ['p1', 'p2'], 'the prospects of each program, never a customer scan');
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.deepEqual(jobs[0].row.result.customer_match.matched, { prospects_checked: 7, likely: 1, possible: 2 },
    'what it found is on the run record');
  assert.equal(s.failed, 0);
});

await test('a failed badge never costs a commission, and before the migration it is simply not installed', async () => {
  for (const [mode, expect] of [['boom', /match boom/], ['missing', null]]) {
    const sb = fake({ matchFail: mode });
    const s = await runCommissions({ supabase: sb, now: () => NOW });
    const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
    assert.deepEqual(jobs.map((x) => x.row.status), ['success', 'success'], `${mode}: the money steps stand`);
    assert.equal(s.failed, 0, `${mode}: the run is not failed by a recruiting aid`);
    assert.equal(s.entries_accrued, 4, `${mode}: commissions accrued as normal`);
    if (expect) assert.match(jobs[0].row.result.customer_match.error, expect, 'the failure is recorded, not hidden');
    else assert.equal(jobs[0].row.result.customer_match.skipped, 'not_installed');
  }
});

await test('two programs in one company share one lookup refresh, and both get badged', async () => {
  const sb = fake({ programs: [{ id: 'p1', company_entity_id: 'c1' }, { id: 'p1b', company_entity_id: 'c1' }] });
  await runCommissions({ supabase: sb, now: () => NOW });
  const refreshes = sb.log.filter((x) => x.rpc === 'refresh_company_customer_profiles');
  const matches = sb.log.filter((x) => x.rpc === 'affiliate_match_prospect_customers');
  assert.ok(refreshes.every((x) => x.args.p_company === 'c1'));
  assert.deepEqual(matches.map((x) => x.args.p_program), ['p1', 'p1b'], 'each program\'s own prospects');
  const first = sb.log.findIndex((x) => x.rpc === 'affiliate_match_prospect_customers' && x.args.p_program === 'p1');
  const second = sb.log.findIndex((x) => x.rpc === 'affiliate_match_prospect_customers' && x.args.p_program === 'p1b');
  assert.equal(sb.log.slice(first, second).filter((x) => x.rpc === 'refresh_company_customer_profiles').length, 0,
    'the lookup is not rebuilt for the second program in the same company');
});

await test('a window that times out is halved and retried, and the halves land', async () => {
  // Anything wider than a day fails, so the 3-day top-up must come back as
  // narrower windows rather than as a lost run.
  const sb = fake({ slowWindow: 86400000, programs: [{ id: 'p1', company_entity_id: 'c1' }] });
  const s = await runCommissions({ supabase: sb, now: () => NOW });
  const w = sb.log.filter((x) => x.rpc === 'refresh_company_customer_profiles');
  assert.ok(w.length > 2, `the window was split, not abandoned (${w.length} calls)`);
  const ok = w.filter((x) => ((x.args.p_until ? Date.parse(x.args.p_until) : NOW.getTime()) - Date.parse(x.args.p_since)) <= 86400000);
  assert.ok(ok.length >= 2, 'the halves that fit were applied');
  // Within one split the oldest half goes first; `covered_from` is stored with
  // least() either way, so a later half cannot move coverage forwards.
  assert.ok(Date.parse(ok[0].args.p_since) < Date.parse(ok[1].args.p_since),
    'the oldest half of a split window is applied first');
  const jobs = sb.log.filter((x) => x.insert === 'sync_jobs');
  assert.equal(jobs[0].row.status, 'success', 'and the run is not failed by it');
  assert.ok(jobs[0].row.result.customer_match.splits >= 1, 'the split is recorded, so a store that always splits is visible');
  assert.equal(s.failed, 0);
});

await test('a chained sync run does not badge: it is a recruiting aid, not a money step', async () => {
  const sb = fake();
  await runCommissions({ supabase: sb, now: () => NOW, onlyCompanyIds: ['c1'], lookbackDays: CHAINED_LOOKBACK_DAYS, source: 'shopify_sync' });
  assert.equal(sb.log.filter((x) => x.rpc && /customer/.test(x.rpc)).length, 0);
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
