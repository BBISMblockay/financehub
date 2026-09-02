#!/usr/bin/env node
/* Test runner for /v3/.
 *
 *   node v3/tests/run.js            everything (browser suites skipped if
 *                                   playwright is not installed)
 *   node v3/tests/run.js --unit     unit only — needs nothing installed
 *   node v3/tests/run.js --browser  browser only
 *   node v3/tests/run.js slicers    any suite whose filename matches
 *
 * Each suite is a standalone script that exits non-zero on failure, and the
 * runner spawns them as separate processes. That is deliberate: a browser
 * suite that hangs or leaks a Chromium cannot then poison the next suite,
 * and any single file can still be run directly while debugging it.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const args = process.argv.slice(2);
const wantUnit = !args.includes('--browser');
const wantBrowser = !args.includes('--unit');
const filters = args.filter((a) => !a.startsWith('--'));

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

const match = (file) => !filters.length
  || filters.some((f) => path.basename(file).includes(f));

const suites = []
  .concat(wantUnit ? list(path.join(HERE, 'unit')) : [])
  .concat(wantBrowser ? list(path.join(HERE, 'browser')) : [])
  .filter(match);

if (!suites.length) {
  console.error('No suites matched.' + (filters.length ? ` Filters: ${filters.join(', ')}` : ''));
  process.exit(1);
}

const playwrightAvailable = (() => {
  try { require.resolve('playwright', { paths: [HERE, path.resolve(HERE, '../../')] }); return true; }
  catch (e) { return false; }
})();

let failed = 0;
let skipped = 0;
const results = [];

for (const suite of suites) {
  const isBrowser = suite.includes(`${path.sep}browser${path.sep}`);
  const name = path.basename(suite, '.test.js');

  if (isBrowser && !playwrightAvailable) {
    console.log(`\n── ${name} ── SKIPPED (playwright not installed)`);
    skipped += 1;
    results.push({ name, status: 'skipped' });
    continue;
  }

  console.log(`\n── ${name} ─────────────────────────────────────────`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [suite], { stdio: 'inherit', cwd: HERE });
  const ms = Date.now() - t0;
  const okRun = r.status === 0;
  if (!okRun) failed += 1;
  results.push({ name, status: okRun ? 'pass' : 'fail', ms });
}

console.log('\n═══════════════════════════════════════════════════');
for (const r of results) {
  const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`  ${tag}  ${r.name}${r.ms ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''}`);
}
console.log('═══════════════════════════════════════════════════');

if (skipped) {
  console.log(`\n${skipped} browser suite(s) skipped. To run them:`);
  console.log('  cd v3/tests && npm install && npx playwright install chromium');
}
if (failed) {
  console.log(`\n${failed} suite(s) FAILED.\n`);
  process.exit(1);
}
console.log(`\nAll ${results.length - skipped} suite(s) passed.\n`);
