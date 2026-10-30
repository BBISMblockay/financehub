/* The database map Ask SILO is shown (schema-map-lib.mjs).
 *
 * These run the real function and assert on the TEXT IT PRODUCES. That
 * distinction is the point of the file: the only coverage this logic had was
 * `has(SRC, 'a one-line entry below is a POINTER, ...')` in prompt.test.mjs,
 * which asserts a sentence exists somewhere in index.ts. It would have passed
 * unchanged through the defect measured on 2026-10-29 -- the index line
 * rendering `description.split('. ')[0]` and so dropping the curated sentence
 * that named the real column -- because that sentence was still in the file.
 *
 * The regression cases below are the real ones from the logs:
 * `launch_calendar` guessed 17 times as lc.launch_title / lc.name, and
 * `v_po_incoming_lines` guessed as po_number / qty_ordered / variant_sku.
 *
 * Run: node supabase/functions/silo-chat/schema-map.test.mjs
 */
import {
  buildSchemaSection,
  SCHEMA_DETAIL_LIMIT,
  SCHEMA_CORE_RELS,
  MAX_INDEX_SUMMARY_CHARS,
} from './schema-map-lib.mjs';

let failures = 0;
let run = 0;
function test(name, fn) {
  run++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

const col = (...names) => names.map((n) => ({ name: n, type: 'text' }));

/** The two relations whose real guessed-column failures this file pins, plus
 *  enough filler to push them out of the detail slice. */
const LAUNCH_CALENDAR = {
  relname: 'launch_calendar',
  relkind: 'table',
  columns: col('id', 'title', 'launch_date', 'preview_start_date', 'status'),
  description: 'Marketing launch pipeline. The name column is title (not launch_name or name); date columns are launch_date and preview_start_date.',
  keywords: ['launch'],
};
const PO_LINES = {
  relname: 'v_po_incoming_lines',
  relkind: 'view',
  columns: col('po_header_id', 'po_name', 'sku', 'qty', 'expected_arrival_date'),
  description: null,
  keywords: null,
};
const filler = (i) => ({
  relname: `filler_${i}`,
  relkind: 'table',
  columns: col('id', 'widget'),
  description: `Filler ${i} about widgets.`,
  keywords: ['widget'],
});
const FILLERS = Array.from({ length: 12 }, (_, i) => filler(i));
const CATALOG = [LAUNCH_CALENDAR, PO_LINES, ...FILLERS];

/** The index-line block only, so a detail card's own column list cannot
 *  satisfy an assertion meant for the index. */
function indexBlock(text) {
  const marker = 'Everything else available';
  const at = text.indexOf(marker);
  assert(at >= 0, 'the map has no index section');
  return text.slice(at);
}

console.log('\n-- the index line carries exact column names --');

test('a relation that did NOT win a detail card still shows its columns', () => {
  // A widget question: the fillers score, launch_calendar does not.
  const { text, detailRelations } = buildSchemaSection('how are widgets doing', CATALOG);
  assert(!detailRelations.includes('launch_calendar'), 'launch_calendar should not be in the detail slice here');
  const idx = indexBlock(text);
  assert(/- launch_calendar \(table\)[^\n]*\n\s*columns: id, title, launch_date, preview_start_date, status/.test(idx),
    'launch_calendar index line is missing its column list');
});

test('the 17 real guesses are absent from the map while the true name is present', () => {
  const { text } = buildSchemaSection('how are widgets doing', CATALOG);
  const idx = indexBlock(text);
  for (const wrong of ['launch_title', 'lc.name']) {
    assert(!idx.includes(`columns: ${wrong}`) && !/columns:[^\n]*\blaunch_title\b/.test(idx),
      `the map offers a column that does not exist: ${wrong}`);
  }
  assert(/columns:[^\n]*\btitle\b/.test(idx), 'the real column name "title" is not offered');
});

test('the second PO case: po_name/qty/sku, never po_number/qty_ordered/variant_sku', () => {
  const { text, detailRelations } = buildSchemaSection('how are widgets doing', CATALOG);
  assert(!detailRelations.includes('v_po_incoming_lines'), 'PO lines should be an index entry here');
  const line = indexBlock(text).split('\n').find((l) => l.includes('v_po_incoming_lines'));
  const cols = indexBlock(text).split('\n')[indexBlock(text).split('\n').indexOf(line) + 1];
  assert(/\bpo_name\b/.test(cols) && /\bqty\b/.test(cols) && /\bsku\b/.test(cols), `real names missing: ${cols}`);
  for (const wrong of ['po_number', 'qty_ordered', 'variant_sku', 'sku_snapshot', 'incoming_qty']) {
    assert(!new RegExp(`\\b${wrong}\\b`).test(cols), `the map offers a nonexistent column: ${wrong}`);
  }
});

test('a relation with no recorded columns says so rather than looking empty', () => {
  const { text } = buildSchemaSection('how are widgets doing',
    [...CATALOG, { relname: 'odd_one', relkind: 'view', columns: [], description: null, keywords: null }]);
  assert(/- odd_one \(view\)\n\s*columns: \(none recorded\)/.test(indexBlock(text)),
    'a column-less relation should state that, not render a bare line');
});

console.log('\n-- the detail slice still works as before --');

test('question wording picks the detail relations, capped at the limit', () => {
  const { detailRelations } = buildSchemaSection('widgets widgets widgets', CATALOG);
  assert(detailRelations.length === SCHEMA_DETAIL_LIMIT, `expected ${SCHEMA_DETAIL_LIMIT} cards, got ${detailRelations.length}`);
  assert(detailRelations.every((r) => r.startsWith('filler_')), `unexpected detail set: ${detailRelations}`);
});

test('an exact relation name in the question outranks keyword matches', () => {
  const { detailRelations } = buildSchemaSection('what is in launch_calendar', CATALOG);
  assert(detailRelations[0] === 'launch_calendar', `expected launch_calendar first, got ${detailRelations}`);
});

test('a question matching nothing is topped up from the core relations', () => {
  const core = SCHEMA_CORE_RELS.map((relname) => ({
    relname, relkind: 'table', columns: col('id'), description: null, keywords: null,
  }));
  const { detailRelations } = buildSchemaSection('zzzz', [...core, LAUNCH_CALENDAR]);
  assert(SCHEMA_CORE_RELS.every((r) => detailRelations.includes(r)),
    `core relations missing from a no-match question: ${detailRelations}`);
});

test('a detail relation is NOT repeated in the index', () => {
  const { text, detailRelations } = buildSchemaSection('what is in launch_calendar', CATALOG);
  assert(detailRelations.includes('launch_calendar'), 'precondition');
  assert(!indexBlock(text).includes('- launch_calendar ('), 'a carded relation should not also be indexed');
});

test('detail cards still carry types; index lines still do not', () => {
  const { text } = buildSchemaSection('what is in launch_calendar', CATALOG);
  assert(text.includes('title (text)'), 'the detail card lost its column types');
  assert(!/columns: [^\n]*\(text\)/.test(indexBlock(text)), 'index lines should carry names only, not types');
});

console.log('\n-- the surrounding instructions --');

test('the index still sends the model to describe_relations for meaning and coverage', () => {
  const { text } = buildSchemaSection('how are widgets doing', CATALOG);
  const idx = indexBlock(text);
  assert(idx.includes('describe_relations'), 'the index no longer names describe_relations');
  assert(/type|business meaning|how far back/.test(idx),
    'the index no longer says what a bare name list leaves out -- the risk of handing over names');
});

test('a long first sentence is truncated, and the cap is honoured', () => {
  const long = { relname: 'wordy', relkind: 'table', columns: col('id'), keywords: null,
    description: `${'x'.repeat(400)}. Second sentence.` };
  const { text } = buildSchemaSection('how are widgets doing', [...CATALOG, long]);
  const line = indexBlock(text).split('\n').find((l) => l.startsWith('- wordy'));
  assert(line.includes('...'), 'a long summary was not truncated');
  assert(line.length < MAX_INDEX_SUMMARY_CHARS + 60, `index line too long: ${line.length}`);
});

test('an empty catalog degrades to discovery guidance, not a broken prompt', () => {
  for (const rows of [[], null, undefined]) {
    const { text, detailRelations } = buildSchemaSection('anything', rows);
    assert(text.includes('Schema map unavailable'), 'missing the degraded path');
    assert(text.includes('never guess a column name'), 'the degraded path lost its instruction');
    assert(detailRelations.length === 0, 'the degraded path should name no detail relations');
  }
});

test('a missing question is not a crash', () => {
  const { detailRelations } = buildSchemaSection(undefined, CATALOG);
  assert(Array.isArray(detailRelations), 'an absent question should still return a map');
});

console.log(`\n${run - failures}/${run} passed`);
process.exit(failures ? 1 : 0);
