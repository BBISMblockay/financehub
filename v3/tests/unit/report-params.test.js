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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
