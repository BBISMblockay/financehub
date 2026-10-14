// The AR sync's source workbook links are Google "publish to web" CSV URLs: the
// URL is the whole access control, so they are supplied at run time and are not
// in git (2026-10-14). Two things have to hold, and only the first is obvious:
//   1. no published-sheet URL is committed anywhere in the tree;
//   2. with the variables unset the module THROWS rather than loading, because a
//      run that fetched nothing would otherwise report a clean zero-row sync of
//      the wholesale book -- the silent success this repo keeps getting bitten by.
//
// This job is a bare checkout with no `npm install`, so the module cannot be
// imported (it pulls node-fetch, papaparse and supabase-js). Its configuration
// prelude -- the real lines from the real file, not a copy -- is run in a vm
// instead: everything above the client construction, with the dependency
// imports stripped, which is the whole of the configuration and both guards.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Extracted lazily, per call. At module scope a reshuffle of ar-sync.mjs would
// throw here and take the committed-URL scan below down with it -- the one check
// that must never stop running quietly.
function preludeOf() {
  const source = fs.readFileSync(path.join(root, 'server/ar-sync.mjs'), 'utf8');
  const cut = source.indexOf('const supabase = createClient(');
  assert.ok(cut > 0, 'ar-sync.mjs no longer builds its client where this test expects');
  // `import` is a syntax error in a vm script; the trailing space in the pattern
  // keeps it from eating an identifier that merely starts with "import".
  return source.slice(0, cut).replace(/^\s*import .*$/gm, '');
}

function loadPrelude(env) {
  const context = {
    process: { env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', ...env } },
  };
  // `const` in a vm script is lexical, so it never lands on the context object;
  // the trailing line is what hands the real values back for inspection.
  const script = `${preludeOf()}\n__out = { SALES_CSV_SOURCES, TERMS_CSV_URL };`;
  try { vm.runInNewContext(script, context); return { out: context.__out }; }
  catch (err) { return { error: err }; }
}

// The prefix Google mints for a PUBLISHED workbook. Matching this rather than
// "docs.google.com" leaves ordinary Drive links alone. Assembled from two halves
// so that this file is not itself a match -- the scan then needs no self-exclusion,
// and an exclusion list is the thing a future URL would get quietly added to.
const PUBLISHED_TOKEN = '2PACX' + '-';

test('no published-sheet URL is committed anywhere in the tree', () => {
  // `git ls-files` is the right surface: exactly what is published and what
  // anyone cloning receives, and it skips node_modules and .git for free.
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString().split('\0').filter(Boolean);
  const offenders = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    // Every tracked file, with no size cap: a cap would skip exactly the large
    // data file a URL is most likely to be buried in.
    if (!stat.isFile()) continue;
    if (fs.readFileSync(full, 'latin1').includes(PUBLISHED_TOKEN)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'a published-sheet URL is committed');
});

test('unset source URLs throw instead of syncing nothing', () => {
  const { error } = loadPrelude({});
  assert.ok(error, 'loaded with no source URLs -- a run would report an empty sync as success');
  assert.match(String(error.message), /AR_SALES_CSV_URLS|AR_TERMS_CSV_URL/);
});

test('sales URLs without a terms URL still throw', () => {
  const { error } = loadPrelude({ AR_SALES_CSV_URLS: 'https://example.invalid/a.csv' });
  assert.ok(error, 'a half-configured dispatch loaded');
});

test('a terms URL without sales URLs still throws', () => {
  const { error } = loadPrelude({ AR_TERMS_CSV_URL: 'https://example.invalid/t.csv' });
  assert.ok(error, 'a half-configured dispatch loaded');
});

test('a configured dispatch loads, and takes several sales URLs', () => {
  const { error, out } = loadPrelude({
    AR_SALES_CSV_URLS: 'https://example.invalid/a.csv https://example.invalid/b.csv',
    AR_TERMS_CSV_URL: 'https://example.invalid/t.csv',
  });
  assert.equal(error, undefined, `the escape hatch no longer loads when configured: ${error?.message}`);
  assert.deepEqual(Array.from(out.SALES_CSV_SOURCES),
    ['https://example.invalid/a.csv', 'https://example.invalid/b.csv']);
  assert.equal(out.TERMS_CSV_URL, 'https://example.invalid/t.csv');
});

test('a comma-separated list parses too, and blanks are dropped', () => {
  const { error, out } = loadPrelude({
    AR_SALES_CSV_URLS: ' https://example.invalid/a.csv , , https://example.invalid/b.csv ',
    AR_TERMS_CSV_URL: 'https://example.invalid/t.csv',
  });
  assert.equal(error, undefined, error?.message);
  assert.deepEqual(Array.from(out.SALES_CSV_SOURCES),
    ['https://example.invalid/a.csv', 'https://example.invalid/b.csv']);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
console.log(`ar-sync source urls: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
