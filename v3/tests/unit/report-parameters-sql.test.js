'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const g = loadV3(PURE_MODULES);
const RB = g.SiloReportBuilder;
const P = g.SiloReportParams;

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const has = (s, sub) => { if (!String(s).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)}\n       got: ${s}`); };
const not = (s, sub) => { if (String(s).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)}\n       got: ${s}`); };

const src = { relname: 'sales_by_product_title_daily_v', relkind: 'view', columns: [
  { name: 'day_date', type: 'date' }, { name: 'product_title', type: 'text' },
  { name: 'net_sales', type: 'numeric' }, { name: 'units', type: 'integer' },
]};
const params = [
  { key: 'date_from', type: 'date', label: 'From', default: 'today-27d' },
  { key: 'date_to', type: 'date', label: 'To', default: 'today' },
];

t('a declared token passes through as a token, not a quoted literal', () => {
  const sql = RB.buildSql(src, { columns: ['day_date','net_sales'], parameters: params,
    filters: [{ column: 'day_date', op: 'gte', value: '{{date_from}}' }] });
  has(sql, 'day_date" >= {{date_from}}');
  not(sql, "'{{date_from}}'");
});

t('gte/lte build a parameterised window', () => {
  const sql = RB.buildSql(src, { columns: ['day_date'], parameters: params, filters: [
    { column: 'day_date', op: 'gte', value: '{{date_from}}' },
    { column: 'day_date', op: 'lte', value: '{{date_to}}' }] });
  has(sql, '>= {{date_from}}'); has(sql, '<= {{date_to}}');
});

t('an UNDECLARED token is quoted as a literal, never emitted raw', () => {
  const sql = RB.buildSql(src, { columns: ['day_date'], parameters: params,
    filters: [{ column: 'product_title', op: 'eq', value: '{{typo}}' }] });
  has(sql, "= '{{typo}}'");
});

t('a token cannot smuggle SQL: the shape is checked, not stripped', () => {
  const sql = RB.buildSql(src, { columns: ['day_date'], parameters: params,
    filters: [{ column: 'product_title', op: 'eq', value: "{{date_from}} or 1=1" }] });
  // Not exactly {{key}}, so it is a literal -- quotes intact, no bare OR.
  has(sql, "= '{{date_from}} or 1=1'");
});

t('the built SQL then substitutes cleanly end to end', () => {
  const sql = RB.buildSql(src, { columns: ['day_date','net_sales'], parameters: params, filters: [
    { column: 'day_date', op: 'gte', value: '{{date_from}}' },
    { column: 'day_date', op: 'lte', value: '{{date_to}}' }] });
  const r = P.substitute(sql, params, { date_from: '2026-08-01', date_to: '2026-08-31' });
  if (r.error) throw new Error(r.error);
  has(r.sql, "date '2026-08-01'"); has(r.sql, "date '2026-08-31'");
  if (P.tokensIn(r.sql).length) throw new Error('tokens left after substitution');
});

t('validateParameters: undeclared token is an ERROR', () => {
  const v = RB.validateParameters('select {{nope}}', params);
  if (!v.errors.length) throw new Error('expected an error');
});
t('validateParameters: unused declaration is a WARNING', () => {
  const v = RB.validateParameters('select {{date_from}}', params);
  if (v.errors.length) throw new Error('unexpected error: ' + v.errors[0]);
  if (!v.warnings.some((w) => /To/.test(w))) throw new Error('expected an unused warning');
});
t('validateParameters: an invalid default is an ERROR', () => {
  const v = RB.validateParameters('select {{x}}',
    [{ key: 'x', type: 'date', label: 'X', default: 'last tuesday' }]);
  if (!v.errors.some((e) => /not valid/.test(e))) throw new Error('expected a default error');
});
t('validateParameters: an incomplete declaration is named, not silently dropped', () => {
  const v = RB.validateParameters('select 1', [{ key: 'grain', type: 'enum', options: [] }]);
  if (!v.errors.some((e) => /incomplete/.test(e))) throw new Error('expected an incomplete error');
});

t('an unparameterised report is byte-identical to before', () => {
  const a = RB.buildSql(src, { columns: ['day_date','net_sales'], dateColumn: 'day_date', dateRange: '30' });
  const b = RB.buildSql(src, { columns: ['day_date','net_sales'], dateColumn: 'day_date', dateRange: '30', parameters: [] });
  if (a !== b) throw new Error('parameters:[] changed the output');
  has(a, 'current_date - 30');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
