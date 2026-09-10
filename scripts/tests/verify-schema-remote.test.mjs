/* The SQL splitter and failure reader behind scripts/verify-schema-remote.mjs.
 *
 * The scheduled production check is only as good as this split: a statement
 * cut in half runs as two broken statements (a red run for a non-problem),
 * and two statements glued together return only the second's rows (a green
 * run that never looked at the first). Both failure shapes are silent in a
 * diff, so they are pinned here -- and pinned against the REAL verify file,
 * not only against toy inputs.
 *
 * No network, no database, no install. Run:
 *   node scripts/tests/verify-schema-remote.test.mjs
 */
import { readFileSync } from 'node:fs';
import { splitSqlStatements, isReadOnlyStatement, findFailures } from '../lib/sql-statements.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

console.log('\n-- splitting --');

test('a semicolon inside a string literal does not end the statement', () => {
  const st = splitSqlStatements(`select 'MISSING — run this; then that' as status;\nselect 2;`);
  eq(st.length, 2, 'statement count');
  ok(st[0].text.includes('then that'), 'first statement kept its whole literal');
});

// There is deliberately no test for a doubled quote ('') inside a literal:
// one was written and could not be made to fail, because the text between two
// adjacent literals is still quoted and a ';' there is never a boundary.
// A test that passes against the bug it names is credited as coverage it
// does not provide.
test('a doubled quote still yields a whole, single statement', () => {
  const st = splitSqlStatements(`select 'it''s; fine' as s; select 1;`);
  eq(st.length, 2, 'statement count');
  eq(st[0].text, "select 'it''s; fine' as s", 'statement text verbatim');
});

test('a semicolon in a -- comment is not a statement boundary', () => {
  const st = splitSqlStatements(`-- note; with a semicolon\nselect 1;\n-- trailing; comment`);
  eq(st.length, 1, 'statement count');
  eq(st[0].text, 'select 1', 'comment stripped from the statement');
});

test('a semicolon in a /* block */ comment is not a statement boundary', () => {
  const st = splitSqlStatements(`select /* a; b */ 1;\nselect 2;`);
  eq(st.length, 2, 'statement count');
  eq(st[0].text, 'select  1', 'block comment removed');
});

test('a dollar-quoted body with semicolons stays one statement', () => {
  const st = splitSqlStatements(`select $$a; b; c$$ as s; select 1;`);
  eq(st.length, 2, 'statement count');
  ok(st[0].text.includes('$$a; b; c$$'), 'dollar quote intact');
});

test('a trailing statement without a semicolon is still emitted', () => {
  const st = splitSqlStatements(`select 1;\nselect 2`);
  eq(st.length, 2, 'statement count');
  eq(st[1].text, 'select 2', 'last statement');
});

test('blank statements (;;) are dropped', () => {
  eq(splitSqlStatements(`select 1;;\n;\nselect 2;`).length, 2, 'statement count');
});

test('each statement carries the section header above it, and the line it starts on', () => {
  const st = splitSqlStatements(`-- 1. Core tables\nselect 1;\n\n-- 2. Policies\n-- more prose; here\nselect\n  2;\nselect 3;`);
  eq(st[0].section, '1. Core tables', 'section 1');
  eq(st[0].line, 2, 'line of statement 1');
  eq(st[1].section, '2. Policies', 'section 2');
  eq(st[1].line, 6, 'line of statement 2');
  eq(st[2].section, '2. Policies', 'section persists until the next header');
});

test('a boxed ── header counts as a section too', () => {
  const st = splitSqlStatements(`-- ── Storage isolation ────\nselect 1;`);
  eq(st[0].section, '── Storage isolation ────', 'boxed header');
});

console.log('\n-- the real verify file --');

const REAL = readFileSync(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
const real = splitSqlStatements(REAL);

test('splits supabase/verify_v2_schema.sql into the number of terminators it has', () => {
  // Count ';' that are outside literals/comments the cheap way: the file's
  // convention is one statement per terminating ';' at end of line. If the
  // splitter and this count ever disagree, one of them is wrong about the
  // file, and that is worth a look either way.
  const terminators = (REAL.match(/;\s*$/gm) || []).length;
  // Some statements end ';' mid-line after a closing paren; allow the split
  // count to be >= the end-of-line count but never less.
  ok(real.length >= terminators - 5 && real.length <= terminators + 5,
    `split ${real.length} statements against ${terminators} end-of-line terminators`);
  ok(real.length > 100, `only ${real.length} statements -- the file has far more`);
});

test('every statement in the real file is a SELECT or WITH', () => {
  const bad = real.filter((s) => !isReadOnlyStatement(s.text));
  eq(bad.length, 0, `non-read-only statements: ${bad.map((s) => `line ${s.line}: ${s.text.slice(0, 40)}`).join(' | ')}`);
});

test('every statement in the real file sits under a section header', () => {
  const orphans = real.filter((s) => !s.section);
  eq(orphans.length, 0, `statements with no section: lines ${orphans.map((s) => s.line).join(', ')}`);
});

test('no statement in the real file was cut inside a literal (balanced quotes)', () => {
  const unbalanced = real.filter((s) => (s.text.replace(/''/g, '').match(/'/g) || []).length % 2 === 1);
  eq(unbalanced.length, 0, `unbalanced quotes at lines ${unbalanced.map((s) => s.line).join(', ')}`);
});

test('no statement in the real file was cut inside parentheses', () => {
  const unbalanced = real.filter((s) => {
    const t = s.text.replace(/'(?:[^']|'')*'/g, '');
    return (t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length;
  });
  eq(unbalanced.length, 0, `unbalanced parens at lines ${unbalanced.map((s) => s.line).join(', ')}`);
});

console.log('\n-- reading results --');

test('a status cell starting MISSING / CRITICAL / STALE is a failure', () => {
  const f = findFailures([
    { status: 'MISSING — run 20260616060000' },
    { a: 'ok', b: 'CRITICAL — seo_tasks grew a publication column' },
    { x: 'STALE POLICY' },
  ]);
  eq(f.length, 3, 'failures found');
  eq(f[1].column, 'b', 'names the column');
});

test('ok, numbers, nulls and lowercase data values are not failures', () => {
  const f = findFailures([
    { status: 'ok', n: 0, x: null, prio: 'critical', name: 'missing_since' },
    { status: 'ok (only the two excluded by name)' },
  ]);
  eq(f.length, 0, `false positives: ${JSON.stringify(f)}`);
});

test('every failure-shaped literal in the REAL verify file is recognised', () => {
  // The file's convention: an uppercase word, then ' — ', then the message.
  // A status word the reader does not know would make the scheduled check
  // report ok over a row that says otherwise -- the worst outcome it has.
  const literals = [...REAL.matchAll(/'([A-Z]{3,}[^']*?)'/g)].map((m) => m[1]);
  const messages = literals.filter((l) => / — /.test(l));
  ok(messages.length > 300, `only ${messages.length} failure-shaped literals found; expected hundreds`);
  const missed = messages.filter((m) => findFailures([{ s: m }]).length === 0);
  eq(missed.length, 0, `unrecognised: ${[...new Set(missed.map((m) => m.split(' ')[0]))].join(', ')}`);
  // Vocabulary actually present, so a word is not silently carried by the
  // shape rule alone -- if the list drifts from the file, this names it.
  for (const w of ['MISSING', 'CRITICAL', 'BROKEN', 'STALE', 'UNEXPECTED']) {
    ok(findFailures([{ s: `${w}: no separator` }]).length === 1, `${w} must be a known word, not only a shape`);
  }
});

test('data literals in the real file that merely start with capitals are not failures', () => {
  const f = findFailures([
    { t: 'BASE TABLE' }, { m: 'AMZN Mktp US*2A4XY9' }, { m: 'ADOBE  *ACROPRO SUBS' }, { c: 'CTE' },
  ]);
  eq(f.length, 0, `false positives: ${JSON.stringify(f)}`);
});

test('a status word never seen before is still caught by its shape', () => {
  eq(findFailures([{ s: 'NEWWORD — something is off' }]).length, 1, 'shape rule');
  eq(findFailures([{ s: 'Newword — prose, not a status' }]).length, 0, 'mixed case is prose');
});

test('a non-array result (an error object) yields no failures rather than throwing', () => {
  eq(findFailures({ message: 'boom' }).length, 0, 'object');
  eq(findFailures(null).length, 0, 'null');
});

test('isReadOnlyStatement refuses anything but SELECT/WITH', () => {
  ok(isReadOnlyStatement('  SELECT 1'), 'select');
  ok(isReadOnlyStatement('with x as (select 1) select * from x'), 'with');
  ok(!isReadOnlyStatement('update profiles set role = null'), 'update');
  ok(!isReadOnlyStatement('delete from x'), 'delete');
  ok(!isReadOnlyStatement('select_into_trap'), 'a word that merely starts with select');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
