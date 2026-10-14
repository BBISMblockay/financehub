/* Unit tests for v3/js/report-params.js — the substitution surface. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const g = loadV3(PURE_MODULES);
const P = g.SiloReportParams;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || ''} expected ${B}, got ${A}`);
};
const ok = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };

const D = {
  grain: { key: 'grain', type: 'enum', label: 'Grain', options: ['day', 'week', 'month', 'ytd'], default: 'week' },
  d: { key: 'report_date', type: 'date', label: 'As of', default: 'today' },
  n: { key: 'min_units', type: 'number', label: 'Min units', default: '0' },
  s: { key: 'channel', type: 'text', label: 'Channel', default: 'web' },
};
const ALL = Object.values(D);

console.log('\n── declarations ──');
t('drops a declaration with a bad key', () =>
  eq(P.normalizeDeclarations([{ key: '1bad', type: 'text' }]), []));
t('drops a declaration with an unknown type', () =>
  eq(P.normalizeDeclarations([{ key: 'x', type: 'sql' }]), []));
t('drops an enum with no options', () =>
  eq(P.normalizeDeclarations([{ key: 'x', type: 'enum', options: [] }]), []));
t('drops a duplicate key, keeping the first', () => {
  const r = P.normalizeDeclarations([{ key: 'x', type: 'text', label: 'A' }, { key: 'x', type: 'number', label: 'B' }]);
  eq(r.length, 1); eq(r[0].label, 'A');
});
t('defaults the label from the key', () =>
  eq(P.normalizeDeclarations([{ key: 'report_date', type: 'date' }])[0].label, 'report date'));

console.log('\n── tokens ──');
t('finds tokens', () => eq(P.tokensIn('select {{a}}, {{b}} from t where x = {{a}}'), ['a', 'b']));
t('tolerates inner whitespace', () => eq(P.tokensIn('{{  grain  }}'), ['grain']));
t('ignores a single brace', () => eq(P.tokensIn('select {a} from t'), []));
t('no tokens in plain sql', () => eq(P.tokensIn('select 1'), []));

console.log('\n── literals: number ──');
t('accepts an integer', () => eq(P.toLiteral(D.n, '42').literal, '42'));
t('accepts a negative float', () => eq(P.toLiteral(D.n, '-1.5').literal, '-1.5'));
t('rejects a non-number', () => ok(P.toLiteral(D.n, 'abc').error));
t('rejects empty', () => ok(P.toLiteral(D.n, '').error));
t('rejects NaN/Infinity', () => { ok(P.toLiteral(D.n, 'NaN').error); ok(P.toLiteral(D.n, 'Infinity').error); });
t('INJECTION: "1 or 1=1" cannot survive Number()', () => ok(P.toLiteral(D.n, '1 or 1=1').error));
t('INJECTION: "0) union select ..." rejected', () =>
  ok(P.toLiteral(D.n, '0) union select password from profiles --').error));

console.log('\n── literals: date ──');
t('accepts an ISO date', () => eq(P.toLiteral(D.d, '2026-09-01').literal, "date '2026-09-01'"));
t('rejects a bogus calendar date', () => ok(P.toLiteral(D.d, '2026-02-31').error));
t('rejects a non-date', () => ok(P.toLiteral(D.d, 'yesterday').error));
t('resolves today', () => ok(/^date '\d{4}-\d{2}-\d{2}'$/.test(P.toLiteral(D.d, 'today').literal)));
t('resolves today-27d to 27 days back', () => {
  const now = new Date();
  const want = P.localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 27));
  eq(P.toLiteral(D.d, 'today-27d').literal, `date '${want}'`);
});
t('resolves month_start to the 1st', () => ok(/-01'$/.test(P.toLiteral(D.d, 'month_start').literal)));
t('resolves year_start to Jan 1', () => ok(/-01-01'$/.test(P.toLiteral(D.d, 'year_start').literal)));
t('INJECTION: date carrying sql is rejected', () =>
  ok(P.toLiteral(D.d, "2026-01-01' or '1'='1").error));

console.log('\n── literals: enum ──');
t('accepts a declared option', () => eq(P.toLiteral(D.grain, 'week').literal, "'week'"));
t('rejects an undeclared option', () => ok(P.toLiteral(D.grain, 'decade').error));
t('is case sensitive (compared, not normalised)', () => ok(P.toLiteral(D.grain, 'WEEK').error));
t('INJECTION: enum allowlist blocks sql', () =>
  ok(P.toLiteral(D.grain, "week' union select 1 --").error));

console.log('\n── literals: text ──');
t('quotes a plain value', () => eq(P.toLiteral(D.s, 'pos').literal, "'pos'"));
t('doubles embedded quotes', () => eq(P.toLiteral(D.s, "O'Brien").literal, "'O''Brien'"));
t('INJECTION: quote-break is neutralised, not passed through', () => {
  const lit = P.toLiteral(D.s, "x' or 1=1 --").literal;
  eq(lit, "'x'' or 1=1 --'");
  // The payload is one string literal: no unbalanced quote escapes it.
  const quotes = (lit.match(/'/g) || []).length;
  ok(quotes % 2 === 0, 'quotes must balance');
});
t('rejects a semicolon (the runner would reject the whole query)', () =>
  ok(P.toLiteral(D.s, 'a;b').error));
t('rejects a control character', () => ok(P.toLiteral(D.s, 'a\u0000b').error));
t('backslash is literal under standard_conforming_strings', () =>
  eq(P.toLiteral(D.s, "a\\'b").literal, "'a\\''b'"));

console.log('\n── substitute ──');
t('passes through SQL with no tokens', () =>
  eq(P.substitute('select 1', ALL, {}).sql, 'select 1'));
t('substitutes the WoW shape', () =>
  eq(P.substitute('select * from wow_kpi_compare({{report_date}}, {{grain}})', ALL,
    { report_date: '2026-09-01', grain: 'day' }).sql,
    "select * from wow_kpi_compare(date '2026-09-01', 'day')"));
t('falls back to the declared default', () =>
  eq(P.substitute('select {{grain}}', ALL, {}).sql, "select 'week'"));
t('an empty supplied value falls back to the default, not an error', () =>
  eq(P.substitute('select {{grain}}', ALL, { grain: '' }).sql, "select 'week'"));
t('substitutes every occurrence of a repeated token', () =>
  eq(P.substitute('select {{grain}}, {{grain}}', ALL, { grain: 'day' }).sql,
    "select 'day', 'day'"));
t('UNDECLARED token is fatal, never left in place', () => {
  const r = P.substitute('select {{sneaky}}', ALL, { sneaky: 'x' });
  ok(r.error, 'must error');
  ok(!r.sql, 'must not return sql');
  ok(/not a declared parameter/.test(r.error));
});
t('a declared parameter with no value and no default errors', () => {
  const r = P.substitute('select {{q}}', [{ key: 'q', type: 'text', label: 'Q' }], {});
  ok(r.error && /needs a value/.test(r.error));
});
t('a bad value fails the whole substitution', () => {
  const r = P.substitute('select {{grain}}', ALL, { grain: 'nope' });
  ok(r.error && !r.sql);
});
t('INJECTION: a value can never introduce a second statement', () => {
  const r = P.substitute('select * from t where c = {{channel}}', ALL,
    { channel: "x'; drop table profiles; --" });
  ok(r.error, 'semicolon must be refused');
});
t('a malformed declaration does not become a usable token', () => {
  // type 'sql' is dropped by normalize, so {{evil}} is then undeclared.
  const r = P.substitute('select {{evil}}', [{ key: 'evil', type: 'sql' }], { evil: '1=1' });
  ok(r.error && /not a declared parameter/.test(r.error));
});

console.log('\n── mergeDeclarations ──');
const W = (id, sql, params) => ({ id, query_sql: sql, report_parameters: params });
t('unions by key across widgets', () => {
  const m = P.mergeDeclarations([
    W('a', 'select {{grain}}', [D.grain]),
    W('b', 'select {{grain}}, {{report_date}}', [D.grain, D.d]),
  ]);
  eq(m.map((x) => x.key).sort(), ['grain', 'report_date']);
  eq(m.find((x) => x.key === 'grain').usedBy, ['a', 'b']);
});
t('ignores a parameter the SQL never uses', () =>
  eq(P.mergeDeclarations([W('a', 'select 1', [D.grain])]), []));
t('ignores a widget with no SQL (private report)', () =>
  eq(P.mergeDeclarations([W('a', null, [D.grain])]), []));
t('intersects enum options so a pick cannot break a tile', () => {
  const m = P.mergeDeclarations([
    W('a', '{{grain}}', [{ key: 'grain', type: 'enum', options: ['day', 'week', 'ytd'] }]),
    W('b', '{{grain}}', [{ key: 'grain', type: 'enum', options: ['week', 'ytd', 'month'] }]),
  ]);
  eq(m[0].options, ['week', 'ytd']);
});
t('flags a type conflict rather than guessing', () => {
  const m = P.mergeDeclarations([
    W('a', '{{x}}', [{ key: 'x', type: 'date' }]),
    W('b', '{{x}}', [{ key: 'x', type: 'text' }]),
  ]);
  ok(/both date and text/.test(m[0].conflict));
});
t('flags disjoint enum options', () => {
  const m = P.mergeDeclarations([
    W('a', '{{x}}', [{ key: 'x', type: 'enum', options: ['a'] }]),
    W('b', '{{x}}', [{ key: 'x', type: 'enum', options: ['b'] }]),
  ]);
  ok(/share no common options/.test(m[0].conflict));
});

console.log('\n── defaultsFor ──');
t('seeds from declared defaults', () => eq(P.defaultsFor([D.grain], null), { grain: 'week' }));
t('saved state wins over the default', () =>
  eq(P.defaultsFor([D.grain], { grain: 'day' }), { grain: 'day' }));
t('omits a parameter with no default and no saved value', () =>
  eq(P.defaultsFor([{ key: 'q', type: 'text', label: 'Q', default: '' }], {}), {}));


// ── month_end / year_end (added for planning reports) ────────────────────
console.log('\n── month_end / year_end ──');
{
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  t('month_end is the last day of this month', () =>
    eq(P.resolveDateExpr('month_end'), iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))));
  t('year_end is 31 Dec of this year', () =>
    eq(P.resolveDateExpr('year_end'), `${now.getFullYear()}-12-31`));
  t('month_end handles February without a month-length table', () => {
    // Day 0 of the next month is the last of this one, leap years included.
    const feb = new Date(2024, 2, 0);
    eq(iso(feb), '2024-02-29');
  });
  t('both survive toLiteral', () => {
    ok(P.toLiteral({ key: 'd', type: 'date', label: 'D' }, 'year_end').literal.startsWith("date '"));
    ok(P.toLiteral({ key: 'd', type: 'date', label: 'D' }, 'month_end').literal.startsWith("date '"));
  });
  // 'quarter_end' used to stand in for "unknown" here; it is a real token
  // since prior-period support, so the refusal is proved with one that is
  // not in PERIOD_LOCAL and never will be.
  t('an unknown relative token is still refused', () =>
    ok(P.toLiteral({ key: 'd', type: 'date', label: 'D' }, 'fortnight_end').error));
}

// ── period boundaries, including the prior-period set ────────────────────
console.log('\n── period boundaries ──');
{
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const at = (y, m, d) => new Date(y, m - 1, d);

  // The whole point of the two-map shape: a token that resolves in only one
  // calendar is a report that works in the browser and breaks in a 7am email.
  t('every period token resolves in BOTH calendars', () => {
    eq(Object.keys(P.PERIOD_LOCAL).sort(), Object.keys(P.PERIOD_SQL).sort());
    eq([...P.PERIOD_KEYS].sort(), Object.keys(P.PERIOD_LOCAL).sort());
    ok(P.PERIOD_KEYS.length >= 16);
  });

  // Fixed "today"s, so these assert arithmetic and not whatever day it is.
  // Wed 2026-03-11: a month after February in a non-leap year, mid-quarter.
  const WED = at(2026, 3, 11);
  const cases = [
    ['week_start', WED, '2026-03-09'],        // Monday of that week
    ['week_end', WED, '2026-03-15'],          // Sunday
    ['prior_week_start', WED, '2026-03-02'],
    ['prior_week_end', WED, '2026-03-08'],
    ['month_start', WED, '2026-03-01'],
    ['month_end', WED, '2026-03-31'],
    ['prior_month_start', WED, '2026-02-01'],
    ['prior_month_end', WED, '2026-02-28'],   // non-leap February
    ['quarter_start', WED, '2026-01-01'],
    ['quarter_end', WED, '2026-03-31'],
    ['prior_quarter_start', WED, '2025-10-01'],
    ['prior_quarter_end', WED, '2025-12-31'],
    ['year_start', WED, '2026-01-01'],
    ['year_end', WED, '2026-12-31'],
    ['prior_year_start', WED, '2025-01-01'],
    ['prior_year_end', WED, '2025-12-31'],
  ];
  for (const [token, now, want] of cases) {
    t(`${token} on ${iso(now)} is ${want}`, () => eq(P.resolveDateExpr(token, now), want));
  }

  // Monday is the boundary, so Monday itself and the Sunday before it are
  // the two days an off-by-one would move.
  t('on a Monday, week_start is that Monday', () =>
    eq(P.resolveDateExpr('week_start', at(2026, 3, 9)), '2026-03-09'));
  t('on a Sunday, week_start is the Monday six days back', () =>
    eq(P.resolveDateExpr('week_start', at(2026, 3, 15)), '2026-03-09'));

  // The cases that break a naive implementation: year boundaries and leap day.
  t('prior_month on 1 January reaches back a year', () => {
    eq(P.resolveDateExpr('prior_month_start', at(2026, 1, 1)), '2025-12-01');
    eq(P.resolveDateExpr('prior_month_end', at(2026, 1, 1)), '2025-12-31');
  });
  t('prior_quarter in Q1 reaches back a year', () => {
    eq(P.resolveDateExpr('prior_quarter_start', at(2026, 2, 20)), '2025-10-01');
    eq(P.resolveDateExpr('prior_quarter_end', at(2026, 2, 20)), '2025-12-31');
  });
  t('prior_month_end finds 29 February in a leap year', () =>
    eq(P.resolveDateExpr('prior_month_end', at(2024, 3, 5)), '2024-02-29'));
  t('month_end finds 29 February in a leap year', () =>
    eq(P.resolveDateExpr('month_end', at(2024, 2, 5)), '2024-02-29'));

  // A browser-calendar report emits a literal; a company-calendar one emits
  // SQL that Postgres evaluates at run time. Neither may emit the raw token.
  t('browser calendar emits a date literal for every token', () => {
    for (const key of P.PERIOD_KEYS) {
      const r = P.toLiteral({ key: 'd', type: 'date', label: 'D' }, key);
      ok(!r.error && /^date '\d{4}-\d{2}-\d{2}'$/.test(r.literal), `${key}: ${r.error || r.literal}`);
    }
  });
  t('company calendar emits silo_business_today() SQL for every token', () => {
    for (const key of P.PERIOD_KEYS) {
      const r = P.toLiteral({ key: 'd', type: 'date', date_basis: 'company', label: 'D' }, key);
      ok(!r.error, `${key}: ${r.error}`);
      ok(r.literal.includes('silo_business_today()'), `${key} is not on the company calendar: ${r.literal}`);
      ok(!r.literal.includes(key), `${key} leaked its token into SQL: ${r.literal}`);
    }
  });
  t('prior_month on the company calendar is the complete previous month', () => {
    const d = { key: 'd', type: 'date', date_basis: 'company', label: 'D' };
    const from = P.toLiteral(d, 'prior_month_start').literal;
    const to = P.toLiteral(d, 'prior_month_end').literal;
    ok(/date_trunc\('month'/.test(from) && /interval '1 month'/.test(from), from);
    ok(/date_trunc\('month'/.test(to) && /interval '1 day'/.test(to), to);
  });
}

t('company-calendar defaults remain relative SQL through normalize/substitute', () => {
  const ds = [{key:'d',type:'date',date_basis:'company',default:'today-28d'}];
  eq(P.substitute('select {{d}}',ds,{}).sql,'select ((select public.silo_business_today()) - 28)');
  eq(P.substitute('select {{d}}',ds,{d:'2024-02-29'}).sql,"select date '2024-02-29'");
  ok(P.substitute('select {{d}}',ds,{d:'today-1d); select 1 --'}).error);
  ok(P.substitute('select {{d}}',ds,{d:'2025-02-29'}).error);
});
t('mixed company/browser calendars do not silently merge', () => {
  const ds=P.mergeDeclarations([
    {id:'a',query_sql:'select {{d}}',report_parameters:[{key:'d',type:'date',date_basis:'company',default:'today'}]},
    {id:'b',query_sql:'select {{d}}',report_parameters:[{key:'d',type:'date',default:'today'}]},
  ]);
  ok(ds[0].conflict);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
