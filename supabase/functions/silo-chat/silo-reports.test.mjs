// SILO reports as Ask SILO's first source (silo-reports-lib.mjs), and the
// vendored copy of the dashboards' parameter rules (report-params-lib.mjs).
// Pure: no model, no database, no network.  node silo-reports.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_REPORT_QUERIES, MAX_REPORT_ROWS_TO_MODEL, buildReportsSection, normalizeReports, prepareReportRun,
  resolveReport, shapeReportResult,
} from './silo-reports-lib.mjs';
import { SiloReportParams } from './report-params-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
let run = 0;
let failures = 0;
function test(name, fn) {
  run++;
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const eq = (a, b, msg) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${msg || 'not equal'}: expected ${y}, got ${x}`);
};

const DAILY = {
  id: '5110de50-0000-4000-a000-000000000001', title: 'Daily Sales',
  description: 'Daily canonical net sales, units and orders. Defaults to 60 days. More detail here.',
  parameters: [
    { key: 'date_from', type: 'date', label: 'From', default: 'today-60d', date_basis: 'company' },
    { key: 'date_to', type: 'date', label: 'To', default: 'today-1d', date_basis: 'company' },
  ],
  queries_run: ['select * from v where d between {{date_from}} and {{date_to}}'],
};
const LOW_STOCK = {
  id: 'c1000000-0000-4000-a000-000000000006', title: 'Low Stock', description: 'Types under N weeks of cover.',
  parameters: [{ key: 'cover_weeks', type: 'number', label: 'Weeks', default: 26 }],
  queries_run: ['select * from cover_v where weeks < {{cover_weeks}}'],
};

console.log('\n-- the vendored copy is the dashboards\' file, byte for byte --');

test('report-params-lib.mjs is v3/js/report-params.js plus its ES-module wrapper, nothing else', () => {
  const original = readFileSync(join(ROOT, 'v3', 'js', 'report-params.js'), 'utf8');
  const copy = readFileSync(join(HERE, 'report-params-lib.mjs'), 'utf8');
  const head = [
    '// GENERATED COPY of v3/js/report-params.js -- do not edit here. Edit the v3',
    '// file and re-copy: silo-reports.test.mjs fails if the two differ.',
    '// Wrapped so the browser IIFE runs as an ES module in the edge function.',
    'const window = {};',
    '',
  ].join('\n');
  const tail = 'export const SiloReportParams = window.SiloReportParams;\n';
  assert(copy.startsWith(head), 'the wrapper header changed');
  assert(copy.endsWith(tail), 'the export footer changed');
  eq(copy.slice(head.length, copy.length - tail.length), original,
    'the copy differs from v3/js/report-params.js; re-copy it (see the header)');
});

console.log('\n-- which reports are offered --');

test('malformed rows are dropped, never offered', () => {
  const out = normalizeReports([
    DAILY,
    { id: 'x', title: '', queries_run: ['select 1'] },
    { id: 'y', title: 'No SQL', queries_run: [] },
    { id: 'z', title: 'Blank SQL', queries_run: ['  '] },
    { id: 'w', title: 'Too many', queries_run: Array.from({ length: MAX_REPORT_QUERIES + 1 }, () => 'select 1') },
    null,
  ]);
  eq(out.map((r) => r.id), [DAILY.id], 'only the good row');
  eq(out[0].parameters.length, 2, 'parameters kept');
});

test('no reports means no prompt section at all', () => {
  eq(buildReportsSection([]), '', 'empty');
  eq(buildReportsSection(null), '', 'null');
});

test('the section leads with the rule, then one line per report with its parameters', () => {
  const text = buildReportsSection(normalizeReports([DAILY, LOW_STOCK]));
  const lines = text.split('\n');
  assert(lines[0].startsWith('SILO reports -- answer from these FIRST.'), lines[0]);
  assert(lines[0].includes('call run_silo_report before writing any SQL of your own'), 'run it first');
  assert(lines[0].includes('never present two numbers for one measure without saying which is SILO\'s'), 'the disagreement rule');
  eq(lines[1], `- ${DAILY.id} — Daily Sales: Daily canonical net sales, units and orders. Parameters: date_from (date, default today-60d); date_to (date, default today-1d).`, 'daily line');
  eq(lines[2], `- ${LOW_STOCK.id} — Low Stock: Types under N weeks of cover. Parameters: cover_weeks (number, default 26).`, 'low stock line');
});

console.log('\n-- finding a report --');

test('by id, or by exact title in any case; never by a partial title', () => {
  const list = normalizeReports([DAILY, LOW_STOCK]);
  eq(resolveReport(list, DAILY.id)?.title, 'Daily Sales', 'id');
  eq(resolveReport(list, 'LOW STOCK')?.id, LOW_STOCK.id, 'title');
  eq(resolveReport(list, 'Daily'), null, 'partial');
  eq(resolveReport(list, ''), null, 'blank');
});

console.log('\n-- turning a report into runnable SQL --');

const [daily, lowStock] = normalizeReports([DAILY, LOW_STOCK]);

test('dates on the company calendar become expressions, explicit dates become literals', () => {
  const res = prepareReportRun(daily, { date_from: '2026-09-01', date_to: 'today-1d' }, SiloReportParams);
  eq(res.queries, ["select * from v where d between date '2026-09-01' and ((select public.silo_business_today()) - 1)"], 'sql');
  eq(res.parameters_used, { date_from: '2026-09-01', date_to: 'today-1d' }, 'recorded as given');
});

test('omitted parameters fall back to the report defaults', () => {
  const res = prepareReportRun(daily, undefined, SiloReportParams);
  assert(res.queries[0].includes('((select public.silo_business_today()) - 60)'), res.queries[0]);
  eq(res.parameters_used, { date_from: 'today-60d', date_to: 'today-1d' }, 'defaults recorded');
});

test('a number given as a JSON number is accepted', () => {
  const res = prepareReportRun(lowStock, { cover_weeks: 12 }, SiloReportParams);
  eq(res.queries, ['select * from cover_v where weeks < 12'], 'sql');
});

test('a parameter the report does not declare is refused, naming the real ones', () => {
  const res = prepareReportRun(daily, { location: 'online' }, SiloReportParams);
  assert(res.error && res.error.startsWith('"Daily Sales" has no parameter "location".'), res.error);
  assert(res.error.includes('Its parameters are: date_from, date_to.'), res.error);
});

test('a value that fails its type is refused, with the report named', () => {
  const res = prepareReportRun(lowStock, { cover_weeks: '12; drop table x' }, SiloReportParams);
  assert(res.error && res.error.startsWith('"Low Stock": '), res.error);
  assert(!res.queries, 'no SQL');
});

console.log('\n-- what the model is handed --');

test('a long result is cut to the leading rows and says so; a short one is untouched', () => {
  const rows = Array.from({ length: MAX_REPORT_ROWS_TO_MODEL + 37 }, (_, i) => ({ i }));
  const long = shapeReportResult('R2', JSON.stringify({ evidence_scope: { x: 1 }, rows }));
  eq(long.result_id, 'R2', 'id');
  eq(long.rows.length, MAX_REPORT_ROWS_TO_MODEL, 'capped');
  eq(long.rows[0], { i: 0 }, 'leading rows kept, in order');
  assert(long.rows_note.startsWith(`Showing the first ${MAX_REPORT_ROWS_TO_MODEL} of ${MAX_REPORT_ROWS_TO_MODEL + 37} rows`), long.rows_note);
  eq(long.evidence_scope, { x: 1 }, 'scope kept');
  const short = shapeReportResult('R1', JSON.stringify([{ a: 1 }]));
  eq(short, { result_id: 'R1', rows: [{ a: 1 }] }, 'a bare array becomes rows, no note');
});

test('text that is not JSON is passed through whole, never spread into characters', () => {
  eq(shapeReportResult('R1', 'not json'), { result_id: 'R1', text: 'not json' }, 'text');
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
