/* pages/report-date-freeze.js — which saved reports are pinned to a date,
 * and the one rewrite that is safe to offer.
 *
 * The bug this exists for: Ask SILO writes the model's SQL verbatim with no
 * `parameters`, so a literal date in that SQL is the window the report
 * reports forever. 35 of 231 saved reports were in that state on
 * production, 2026-10-14. The fix is only worth having if it NEVER
 * rewrites a report into a different question, so most of this suite is
 * about what the rewrite refuses. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('../lib/load');

const g = { console };
g.window = g;
g.globalThis = g;
vm.createContext(g);
vm.runInContext(
  fs.readFileSync(path.join(REPO_ROOT, 'pages', 'report-date-freeze.js'), 'utf8'), g,
  { filename: 'report-date-freeze.js' },
);
const F = g.SiloReportDateFreeze;

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ok   ${name}`); };

console.log('\n── finding a frozen date ──');

t('both literal shapes are found', () => {
  const lits = F.findLiterals("select 1 where d between '2026-09-01' and date '2026-09-30'");
  assert.deepEqual(lits.map((l) => l.date), ['2026-09-01', '2026-09-30']);
  assert.equal(lits[1].match, "date '2026-09-30'",
    'the date keyword is part of the match, or a rewrite leaves it in front of a token');
});

t('a timestamp or a number that merely looks date-ish is not a date literal', () => {
  assert.deepEqual(F.findLiterals("select '2026-9-1', '20260901', 'abcd-ef-gh'").length, 0);
});

t('a report with no dates is not frozen', () => {
  assert.equal(F.inspect(['select * from t'], []).frozen, false);
});

t('a report with literal dates and NO date parameter is frozen', () => {
  const info = F.inspect(["select * from t where d between '2026-09-01' and '2026-09-30'"], []);
  assert.equal(info.frozen, true);
  assert.equal(info.from, '2026-09-01');
  assert.equal(info.to, '2026-09-30');
  assert.ok(/2026-09-01 → 2026-09-30/.test(F.describe(info)), F.describe(info));
});

// A report that already HAS a date parameter may legitimately carry a
// literal somewhere else -- a launch day, a cohort start. Warning about
// those would train people to ignore the warning.
t('a report that declares a date parameter is never called frozen', () => {
  const info = F.inspect(
    ["select * from t where d between {{date_from}} and {{date_to}} and launched = '2024-04-01'"],
    [{ key: 'date_from', type: 'date' }, { key: 'date_to', type: 'date' }],
  );
  assert.equal(info.frozen, false);
  assert.equal(F.describe(info), '');
});

t('dates are collected across every query of a multipart report', () => {
  const info = F.inspect(["select '2026-09-01'", "select '2026-09-30'"], []);
  assert.deepEqual(info.dates, ['2026-09-01', '2026-09-30']);
});

console.log('\n── what the rewrite refuses ──');

// Each of these could be parameterised SOME way, and every way is a guess.
// A wrong guess changes what the report means and still returns rows.
t('one date is refused: it could be an as-of, a cutoff or a cohort start', () => {
  const r = F.parameterize(["select * from t where d >= '2026-09-01'"]);
  assert.ok(r.error && !r.queries, JSON.stringify(r));
  assert.ok(/one fixed date/.test(r.error), r.error);
});

t('three or more dates are refused: which two are the window is a guess', () => {
  const r = F.parameterize([
    "select * from t where d between '2026-09-01' and '2026-09-30' "
    + "union all select * from t where d >= '2025-09-01'"]);
  assert.ok(r.error && !r.queries, JSON.stringify(r));
  assert.ok(/3 fixed dates/.test(r.error), r.error);
});

t('no dates at all is refused rather than rewritten to nothing', () => {
  assert.ok(F.parameterize(['select 1']).error);
});

t('a backwards window is refused', () => {
  assert.equal(F.defaultsForWindow('2026-09-30', '2026-09-01'), null);
  assert.equal(F.defaultsForWindow('not-a-date', '2026-09-01'), null);
});

console.log('\n── the rewrite it does make ──');

t('exactly two dates become {{date_from}} and {{date_to}}', () => {
  const sql = "select x from t where d between '2026-09-01' and date '2026-09-30' order by 1";
  const r = F.parameterize([sql]);
  assert.ok(!r.error, r.error);
  assert.equal(r.queries[0],
    'select x from t where d between {{date_from}} and {{date_to}} order by 1');
  // The `date` keyword went with the literal; a leftover one would make
  // `date {{date_to}}` and then `date date '2026-09-30'` after substitution.
  assert.ok(!/date\s+\{\{/.test(r.queries[0]), r.queries[0]);
});

t('every occurrence of the same date is replaced, not just the first', () => {
  const r = F.parameterize([
    "select * from a where d >= '2026-09-01' and d <= '2026-09-30' "
    + "union all select * from b where d >= '2026-09-01' and d <= '2026-09-30'"]);
  assert.ok(!r.error, r.error);
  assert.equal((r.queries[0].match(/\{\{date_from\}\}/g) || []).length, 2);
  assert.equal((r.queries[0].match(/\{\{date_to\}\}/g) || []).length, 2);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(r.queries[0]), r.queries[0]);
});

t('the window is split across two queries and both are rewritten', () => {
  const r = F.parameterize(["select '2026-09-01'::date", "select '2026-09-30'::date"]);
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.queries, ['select {{date_from}}::date', 'select {{date_to}}::date']);
});

t('the declarations are company-calendar dates, so Postgres resolves them', () => {
  const r = F.parameterize(["select * from t where d between '2026-09-01' and '2026-09-30'"]);
  assert.deepEqual(r.parameters.map((p) => p.key), ['date_from', 'date_to']);
  for (const p of r.parameters) {
    assert.equal(p.type, 'date');
    assert.equal(p.date_basis, 'company',
      'a browser-resolved date would use whichever timezone saved the report');
  }
});

console.log('\n── the default the rewrite picks ──');

// The LENGTH is what is worth keeping. Someone who asked about 30 days
// wants a rolling 30, not a rolling however-long-ago-that-was.
t('a 30-day window becomes a rolling 30 days ending yesterday', () => {
  assert.deepEqual(F.defaultsForWindow('2026-09-01', '2026-09-30'),
    { from: 'prior_month_start', to: 'prior_month_end' });
  assert.deepEqual(F.defaultsForWindow('2026-09-02', '2026-10-01'),
    { from: 'today-30d', to: 'today-1d' });
});

t('a whole calendar month becomes prior_month, not a day count', () => {
  // 28, 30 and 31 days are not interchangeable with "last month".
  assert.deepEqual(F.defaultsForWindow('2026-02-01', '2026-02-28'),
    { from: 'prior_month_start', to: 'prior_month_end' });
  assert.deepEqual(F.defaultsForWindow('2024-02-01', '2024-02-29'),
    { from: 'prior_month_start', to: 'prior_month_end' }, 'leap February is still a whole month');
  assert.deepEqual(F.defaultsForWindow('2026-01-01', '2026-01-31'),
    { from: 'prior_month_start', to: 'prior_month_end' });
});

t('a month that is nearly whole is a day count, not prior_month', () => {
  // Starting on the 2nd, or ending a day early, is not "last month".
  assert.deepEqual(F.defaultsForWindow('2026-01-02', '2026-01-31'), { from: 'today-30d', to: 'today-1d' });
  assert.deepEqual(F.defaultsForWindow('2026-01-01', '2026-01-30'), { from: 'today-30d', to: 'today-1d' });
});

t('a single day is a one-day rolling window, inclusive of both ends', () => {
  assert.deepEqual(F.defaultsForWindow('2026-09-15', '2026-09-15'), { from: 'today-1d', to: 'today-1d' });
});

t('a 7-day window is 7 days, not 6 -- both ends are inclusive', () => {
  assert.deepEqual(F.defaultsForWindow('2026-09-01', '2026-09-07'), { from: 'today-7d', to: 'today-1d' });
});

// Every default the rewrite can produce has to be a token report-params
// actually resolves, or the rewritten report errors on its first run.
console.log('\n── the defaults are tokens report-params understands ──');
{
  const { loadV3 } = require('../lib/load');
  const P = loadV3(['report-params.js']).SiloReportParams;
  t('every default resolves to a date', () => {
    const windows = [
      ['2026-09-01', '2026-09-30'], ['2026-02-01', '2026-02-28'], ['2026-09-15', '2026-09-15'],
      ['2026-01-02', '2026-03-15'], ['2026-09-01', '2026-09-07'], ['2025-01-01', '2026-10-01'],
    ];
    for (const [a, b] of windows) {
      const d = F.defaultsForWindow(a, b);
      assert.ok(d, `${a}..${b} produced no defaults`);
      for (const v of [d.from, d.to]) {
        assert.ok(P.resolveDateExpr(v), `${a}..${b}: ${v} is not a token report-params resolves`);
      }
    }
  });

  t('a rewritten report substitutes with no token left and no date frozen', () => {
    const r = F.parameterize(["select * from t where d between '2026-09-01' and '2026-09-30'"]);
    const sub = P.substitute(r.queries[0], r.parameters, {});
    assert.ok(!sub.error, sub.error);
    assert.ok(!/\{\{/.test(sub.sql), sub.sql);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(sub.sql), `a date survived into the SQL: ${sub.sql}`);
    assert.ok(/silo_business_today\(\)/.test(sub.sql), sub.sql);
  });

  t('and the report it produces is no longer reported as frozen', () => {
    const r = F.parameterize(["select * from t where d between '2026-09-01' and '2026-09-30'"]);
    assert.equal(F.inspect(r.queries, r.parameters).frozen, false);
  });
}

console.log(`\n${pass} passed, 0 failed\n`);
