import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertMetaBootstrapComplete } from '../lib/meta-bootstrap-result.mjs';
const complete = { ad_level: { ad_rows_upserted: 0 }, organic: { configured: false } };
assert.doesNotThrow(() => assertMetaBootstrapComplete(complete));
assert.doesNotThrow(() => assertMetaBootstrapComplete({ ad_level: { ad_rows_upserted: 12 } }, { skipOrganic: true }));
for (const result of [null, {}, { kpi_rows_upserted: 1 }, { ad_level: { error: '502' } },
  { ad_level: {} }, { ...complete, organic: null }, { ...complete, organic: { skipped: 'ADS_SKIP_ORGANIC' } },
  { ...complete, organic: { page_error: '502' } }, { ...complete, organic: { error: '429' } }]) {
  assert.throws(() => assertMetaBootstrapComplete(result), /initial import incomplete/);
}
// These optional profile snapshots do not govern the historical window.
assert.doesNotThrow(() => assertMetaBootstrapComplete({ ...complete, organic: { ig_account_error: '403', page_posts_error: '403' } }));
const src = readFileSync(new URL('../ad-platforms-sync.mjs', import.meta.url), 'utf8');
assert.ok(src.indexOf('assertMetaBootstrapComplete(result') < src.indexOf('...metaAfterHistory(connection.meta'));
assert.match(src, /BOOTSTRAP_STRICT && clientSide.length/);
assert.match(src, /if \(BOOTSTRAP_STRICT\) throw new Error\('Initial import connection is no longer eligible'\)/);
console.log('Meta bootstrap result: 15 cases passed');
